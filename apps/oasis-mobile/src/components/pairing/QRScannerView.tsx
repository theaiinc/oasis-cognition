import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Camera, AlertCircle } from 'lucide-react';

interface QRScannerViewProps {
  onScan: (data: string) => void;
  loading: boolean;
  error: string | null;
}

export function QRScannerView({ onScan, loading, error }: QRScannerViewProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const hasScanned = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const scanner = new Html5Qrcode('qr-reader');
    scannerRef.current = scanner;

    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        if (hasScanned.current) return;
        hasScanned.current = true;
        scanner.stop().catch(() => {});
        onScan(decodedText);
      },
      () => {}, // ignore scan failures
    ).catch((err) => {
      setCameraError(
        err.toString().includes('NotAllowedError')
          ? 'Camera access denied. Please allow camera access in your browser settings.'
          : `Camera error: ${err.message || err}`,
      );
    });

    return () => {
      scanner.stop().catch(() => {});
      hasScanned.current = false;
    };
  }, [onScan]);

  return (
    <div className="h-full flex flex-col items-center justify-center bg-[#0a0f1a] px-6">
      <div className="w-full max-w-sm flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-2">Oasis Mobile</h1>
          <p className="text-sm text-slate-400">
            Scan the QR code displayed on your desktop to connect
          </p>
        </div>

        {cameraError ? (
          <div className="w-full bg-red-900/30 border border-red-800 rounded-xl p-6 text-center">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-sm text-red-300">{cameraError}</p>
          </div>
        ) : (
          <div className="w-full aspect-square rounded-xl overflow-hidden border-2 border-slate-700 relative">
            <div id="qr-reader" ref={containerRef} className="w-full h-full" />
            {loading && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-slate-300">Connecting...</p>
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="w-full bg-red-900/30 border border-red-800 rounded-lg p-3 text-center">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        <div className="flex items-center gap-2 text-slate-500 text-xs">
          <Camera className="w-3.5 h-3.5" />
          <span>Point your camera at the QR code</span>
        </div>
      </div>
    </div>
  );
}
