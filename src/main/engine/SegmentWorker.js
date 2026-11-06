// src/main/engine/SegmentWorker.js
const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class SegmentWorker {
  /**
   * Executes a single segment HTTP Range transfer with exponential backoff retries.
   *
   * @param {Object} options
   * @param {Object} options.task
   * @param {Object} options.segment
   * @param {Map} options.activeControllers
   * @param {Function} options.scheduleSave
   * @param {number} [options.maxRetries=5]
   */
  static async downloadWithRetry({ task, segment, activeControllers, scheduleSave, maxRetries = 5 }) {
    let attempt = 0;

    while (attempt <= maxRetries) {
      if (task.status !== 'downloading') return;

      const controller = new AbortController();
      controller.isBoundaryCutoff = false;

      const taskControllers = activeControllers.get(task.id);
      if (taskControllers) {
        taskControllers.set(segment.id, controller);
      }

      try {
        segment.status = 'active';
        await SegmentWorker.streamSegmentWithBoundaryGuard(task, segment, controller);
        segment.status = 'completed';
        scheduleSave();
        return;
      } catch (err) {
        // Check if abort was triggered intentionally by reaching a work-stealing split point
        if (controller.isBoundaryCutoff) {
          segment.status = 'completed';
          scheduleSave();
          return;
        }

        if (controller.signal.aborted || task.status === 'paused') {
          segment.status = 'pending';
          return;
        }

        attempt++;
        if (attempt > maxRetries) {
          segment.status = 'error';
          throw new Error(`Segment ${segment.id} failed after ${maxRetries} retries: ${err.message}`);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s...
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        if (taskControllers) {
          taskControllers.delete(segment.id);
        }
      }
    }
  }

  /**
   * Streams an HTTP byte range while enforcing the live `segment.endByte` limit.
   * If dynamic work-stealing shrinks `segment.endByte` while this stream is active,
   * `boundaryTransform` slices the exact final chunk, signals EOF to flush writeStream to disk,
   * and closes the stream cleanly.
   *
   * @param {Object} task
   * @param {Object} segment
   * @param {AbortController} controller
   */
  static async streamSegmentWithBoundaryGuard(task, segment, controller) {
    if (segment.endByte !== -1 && segment.currentOffset > segment.endByte) {
      return;
    }

    const headers = { ...task.headers };
    if (task.supportsRanges && segment.endByte !== -1) {
      headers.Range = `bytes=${segment.currentOffset}-${segment.endByte}`;
    }

    const res = await fetch(task.url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} on segment ${segment.id}`);
    }
    if (task.supportsRanges && segment.endByte !== -1 && res.status !== 206) {
      throw new Error(`Server returned HTTP ${res.status} instead of 206 Partial Content on segment ${segment.id}`);
    }

    // Open write stream positioned precisely at segment.currentOffset
    const writeStream = fs.createWriteStream(task.partPath, {
      flags: 'r+',
      start: segment.currentOffset,
      highWaterMark: 1024 * 64, // 64 KB buffer
    });

    const nodeReadable = Readable.fromWeb(res.body);
    let reachedBoundary = false;

    const boundaryTransform = new Transform({
      transform(chunk, _encoding, callback) {
        // Unbounded single-stream fallback
        if (segment.endByte === -1) {
          segment.currentOffset += chunk.length;
          task.downloadedBytes += chunk.length;
          return callback(null, chunk);
        }

        const remainingAllowed = segment.endByte - segment.currentOffset + 1;
        if (remainingAllowed <= 0) {
          reachedBoundary = true;
          this.push(null);
          return callback();
        }

        if (chunk.length < remainingAllowed) {
          segment.currentOffset += chunk.length;
          task.downloadedBytes += chunk.length;
          callback(null, chunk);
        } else {
          // Exactly reached or exceeded mutated split boundary
          const exactSlice = chunk.subarray(0, remainingAllowed);
          segment.currentOffset += exactSlice.length;
          task.downloadedBytes += exactSlice.length;
          this.push(exactSlice);
          this.push(null); // Signal EOF downstream so writeStream flushes and finishes cleanly!
          reachedBoundary = true;
          callback();
        }
      },
    });

    try {
      await pipeline(nodeReadable, boundaryTransform, writeStream, { signal: controller.signal });
    } catch (err) {
      if (reachedBoundary) {
        controller.isBoundaryCutoff = true;
        return;
      }
      throw err;
    }

    if (reachedBoundary) {
      controller.isBoundaryCutoff = true;
      try {
        controller.abort();
      } catch {}
    }
  }
}

module.exports = { SegmentWorker };
