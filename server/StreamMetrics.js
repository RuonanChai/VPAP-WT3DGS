/**
 * Server-side Stream Metrics Logger
 * Purpose: Record active_streams(t) for baseline3 and baseline4
 * 
 * Metrics recorded:
 * - ts: timestamp
 * - active_streams: number of active unidirectional streams
 */

export class StreamMetrics {
  constructor(baselineName, metadata = {}) {
    this.baselineName = baselineName;
    this.metadata = {
      run_id: metadata.run_id || `run_${Date.now()}`,
      scenario_id: metadata.scenario_id || 'gs-campus',
      cache_state: metadata.cache_state || 'cold', // 'cold' or 'warm'
      camera_trace_id: metadata.camera_trace_id || 'default',
      timestamp: new Date().toISOString(),
      ...metadata
    };
    this.metrics = []; // Array of { ts, active_streams }
    this.activeStreams = 0;
    this.startTime = Date.now();
    this.payloadBytesTotal = 0;
    
    console.log(`[StreamMetrics] ${baselineName} stream metrics collection started`, this.metadata);
  }

  /**
   * Record stream opened
   */
  streamOpened() {
    this.activeStreams++;
    this.record();
  }

  /**
   * Record stream closed
   */
  streamClosed() {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
    this.record();
  }

  addPayloadBytes(n) {
    const b = Number(n) || 0;
    if (b > 0) this.payloadBytesTotal += b;
  }

  /**
   * Record current state
   */
  record() {
    const ts = Date.now() - this.startTime;
    this.metrics.push({
      ts: ts,
      active_streams: this.activeStreams
    });
    
    // Log every 100 records
    if (this.metrics.length % 100 === 0) {
      console.log(`[StreamMetrics] ts=${ts}ms, active_streams=${this.activeStreams}`);
    }
  }

  /**
   * Export metrics as JSON
   */
  exportMetrics() {
    return {
      baseline: this.baselineName,
      metadata: this.metadata,
      stream_metrics: this.metrics,
      summary: {
        max_active_streams: this.metrics.length > 0 
          ? Math.max(...this.metrics.map(m => m.active_streams)) 
          : 0,
        avg_active_streams: this.metrics.length > 0
          ? this.metrics.reduce((sum, m) => sum + m.active_streams, 0) / this.metrics.length
          : 0,
        total_samples: this.metrics.length,
        payload_bytes_total: this.payloadBytesTotal,
        payload_bytes_source: 'server_write_after_splat'
      }
    };
  }

  /**
   * Write metrics to file
   */
  async writeToFile(filePath) {
    const fs = await import('fs');
    const data = JSON.stringify(this.exportMetrics(), null, 2);
    fs.writeFileSync(filePath, data, 'utf8');
    console.log(`[StreamMetrics] Metrics written to ${filePath}`);
  }
  
  /**
   * Generate filename with metadata
   */
  generateFilename(suffix = 'latest') {
    return `stream_metrics_${this.baselineName}_${this.metadata.run_id}_${this.metadata.scenario_id}_${this.metadata.cache_state}_${this.metadata.camera_trace_id}_${suffix}.json`;
  }
}

