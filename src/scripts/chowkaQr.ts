// Draw QR codes and read them with the camera.
//
// Drawing uses lean-qr. Reading uses the browser's BarcodeDetector where it
// exists (Chrome on Android) and jsQR everywhere else, including Safari on
// iPhone, which has no built-in detector. jsQR loads only when first needed.
import { generate, correction } from 'lean-qr';

/** An SVG of `text` as a QR code, dark modules on a light quiet zone. */
export function qrSvg(text: string, label: string) {
  const code = generate(text, { minCorrectionLevel: correction.L });
  const pad = 3;
  const size = code.size + pad * 2;
  let path = '';
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      // Merge runs of dark modules into one rectangle to keep the path short.
      if (!code.get(x, y)) continue;
      let run = 1;
      while (x + run < code.size && code.get(x + run, y)) run++;
      path += `M${x + pad} ${y + pad}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#111"/></svg>`;
}

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };

/** Scans the camera until a QR code passes `accept`, then stops. */
export class QrScanner {
  private stream: MediaStream | null = null;
  private timer = 0;
  private stopped = true;

  constructor(private video: HTMLVideoElement, private onCode: (text: string) => boolean | Promise<boolean>) {}

  async start() {
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (this.stopped) { this.release(); return; }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    const detect = await this.detector();
    const tick = async () => {
      if (this.stopped) return;
      try {
        const text = await detect();
        if (text && !this.stopped && await this.onCode(text)) { this.stop(); return; }
      } catch { /* A frame that cannot be read yet. */ }
      if (!this.stopped) this.timer = window.setTimeout(tick, 120);
    };
    tick();
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.release();
  }

  private release() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  private async detector(): Promise<() => Promise<string | null>> {
    const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (Native) {
      try {
        const native = new Native({ formats: ['qr_code'] });
        return async () => (await native.detect(this.video))[0]?.rawValue ?? null;
      } catch { /* Fall back to jsQR. */ }
    }
    const { default: jsQR } = await import('jsqr');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    return async () => {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (!w || !h) return null;
      // Reading a smaller copy is much faster and still finds a phone-screen code.
      const scale = Math.min(1, 720 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    };
  }
}
