import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  tail: string;
}

/**
 * Runs ffmpeg. `onTime` receives the seconds of output written so far, read from ffmpeg's own
 * -progress stream, so the progress shown to the person is what ffmpeg actually reports.
 */
export function runFfmpeg(args: string[], onTime?: (seconds: number) => void, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onTime) onTime(Number(m[1]) / 1e6);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, tail }));
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  });
}

export interface ClipInfo {
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number;
  height: number;
  /** HLG or PQ: needs tone mapping to look right in an ordinary 720p MP4. */
  hdr: boolean;
}

export function probe(file: string): Promise<ClipInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('unreadable'));
      try {
        const j = JSON.parse(out) as {
          streams?: { codec_type: string; width?: number; height?: number; color_transfer?: string; duration?: string; disposition?: { attached_pic?: number } }[];
          format?: { duration?: string };
        };
        const v = j.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
        const a = j.streams?.find((s) => s.codec_type === 'audio');
        const duration = Number(j.format?.duration ?? v?.duration ?? 0);
        resolve({
          duration: Number.isFinite(duration) ? duration : 0,
          hasAudio: Boolean(a),
          hasVideo: Boolean(v),
          width: v?.width ?? 0,
          height: v?.height ?? 0,
          hdr: v?.color_transfer === 'arib-std-b67' || v?.color_transfer === 'smpte2084',
        });
      } catch {
        reject(new Error('unreadable'));
      }
    });
  });
}
