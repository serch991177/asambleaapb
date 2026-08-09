import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { BrowserQRCodeReader, IScannerControls } from '@zxing/browser';
import { API_BASE_URL } from '../api.config';
type FeedbackKind = 'success' | 'already' | 'invalid' | 'unauthorized' | 'error';

type CheckInResponse = {
  valid?: boolean;
  status?: 'checked_in' | 'already_checked_in' | 'not_found';
  code?: string;
  full_name?: string;
  checked_in_at?: string | null;
  message?: string;
  errors?: Record<string, string[]>;
};

type ScanFeedback = {
  kind: FeedbackKind;
  title: string;
  message: string;
  code?: string;
  fullName?: string;
  checkedInAt?: string | null;
};

@Component({
  selector: 'app-qr-scanner',
  templateUrl: './qr-scanner.component.html',
  styleUrl: './qr-scanner.component.css',
})
export class QrScannerComponent implements OnDestroy {
  @ViewChild('scannerVideo') private scannerVideo?: ElementRef<HTMLVideoElement>;

  private static readonly eventId = 'ASAMBLEA-NACIONAL-2026';
  private static readonly codePattern = /^AN26-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
  private static readonly sessionTokenKey = 'apb-scanner-access-token';
  private static readonly dateFormatter = new Intl.DateTimeFormat('es-BO', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'America/La_Paz',
  });

  private readonly http = inject(HttpClient);
  private codeReader?: BrowserQRCodeReader;
  private controls?: IScannerControls;
  private cameraRun = 0;

  readonly operatorToken = signal('');
  readonly rememberToken = signal(false);
  readonly manualCode = signal('');
  readonly cameraActive = signal(false);
  readonly startingCamera = signal(false);
  readonly processing = signal(false);
  readonly cameraMessage = signal('');
  readonly feedback = signal<ScanFeedback | null>(null);

  constructor() {
    try {
      const savedToken = window.sessionStorage.getItem(QrScannerComponent.sessionTokenKey);
      if (savedToken) {
        this.operatorToken.set(savedToken);
        this.rememberToken.set(true);
      }
    } catch {
      // El escáner sigue funcionando aunque el navegador bloquee sessionStorage.
    }
  }

  ngOnDestroy(): void {
    this.stopCamera();
  }

  updateOperatorToken(event: Event): void {
    this.operatorToken.set((event.target as HTMLInputElement).value);
    this.persistTokenForSession();
  }

  updateManualCode(event: Event): void {
    this.manualCode.set((event.target as HTMLInputElement).value.toUpperCase());
  }

  toggleRememberToken(event: Event): void {
    this.rememberToken.set((event.target as HTMLInputElement).checked);
    this.persistTokenForSession();
  }

  async startCamera(): Promise<void> {
    this.feedback.set(null);
    this.cameraMessage.set('');

    if (!this.operatorToken().trim()) {
      this.cameraMessage.set('Ingresa la clave de operador antes de activar la cámara.');
      return;
    }

    if (!window.isSecureContext) {
      this.cameraMessage.set(
        'La cámara requiere HTTPS. En desarrollo también funciona en localhost.',
      );
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || !this.scannerVideo) {
      this.cameraMessage.set(
        'Este navegador no ofrece acceso compatible a la cámara. Usa el ingreso manual.',
      );
      return;
    }

    this.stopCamera();
    const currentRun = ++this.cameraRun;
    this.startingCamera.set(true);

    try {
      const codeReader = await this.getCodeReader();
      if (currentRun !== this.cameraRun) {
        return;
      }

      const controls = await codeReader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        this.scannerVideo.nativeElement,
        (result) => {
          if (result && !this.processing() && !this.feedback()) {
            void this.validateRawValue(result.getText());
          }
        },
      );

      if (currentRun !== this.cameraRun) {
        controls.stop();
        return;
      }

      this.controls = controls;
      this.cameraActive.set(true);
    } catch (caught) {
      if (currentRun !== this.cameraRun) {
        return;
      }

      const errorName = caught instanceof DOMException ? caught.name : '';
      this.cameraMessage.set(
        errorName === 'NotAllowedError'
          ? 'Permiso de cámara denegado. Habilítalo en el navegador o usa el ingreso manual.'
          : 'No se pudo iniciar la cámara. Revisa los permisos o usa el ingreso manual.',
      );
      this.cameraActive.set(false);
    } finally {
      if (currentRun === this.cameraRun) {
        this.startingCamera.set(false);
      }
    }
  }

  stopCamera(): void {
    this.cameraRun += 1;
    this.controls?.stop();
    this.controls = undefined;

    const video = this.scannerVideo?.nativeElement;
    if (video?.srcObject instanceof MediaStream) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }

    this.cameraActive.set(false);
    this.startingCamera.set(false);
  }

  validateManual(event: SubmitEvent): void {
    event.preventDefault();
    void this.validateRawValue(this.manualCode());
  }

  scanNext(): void {
    this.feedback.set(null);
    this.cameraMessage.set('');
    this.manualCode.set('');
    void this.startCamera();
  }

  formatCheckedInAt(value?: string | null): string {
    if (!value) {
      return '';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : QrScannerComponent.dateFormatter.format(date);
  }

  private async validateRawValue(rawValue: string): Promise<void> {
    if (this.processing()) {
      return;
    }

    this.cameraMessage.set('');
    const parsed = this.parseAccreditation(rawValue);
    this.stopCamera();

    if (!parsed.code) {
      this.feedback.set({
        kind: 'invalid',
        title: 'QR no válido',
        message: parsed.message,
      });
      return;
    }

    const token = this.operatorToken().trim();
    if (!token) {
      this.feedback.set({
        kind: 'unauthorized',
        title: 'Falta la clave de operador',
        message: 'Ingresa la clave asignada al personal de acreditación e intenta nuevamente.',
        code: parsed.code,
      });
      return;
    }

    this.processing.set(true);
    this.feedback.set(null);
    this.persistTokenForSession();

    try {
      const response = await firstValueFrom(
        this.http.post<CheckInResponse>(
          `${API_BASE_URL}/api/check-in`,
          { code: parsed.code },
          { headers: new HttpHeaders({ 'X-Scanner-Token': token }) },
        ),
      );

      this.feedback.set({
        kind: 'success',
        title: 'Asistencia validada',
        message: response.message || 'La acreditación quedó registrada correctamente.',
        code: response.code,
        fullName: response.full_name,
        checkedInAt: response.checked_in_at,
      });
    } catch (caught) {
      this.feedback.set(this.feedbackFromError(caught, parsed.code));
    } finally {
      this.processing.set(false);
    }
  }

  private parseAccreditation(rawValue: string): { code: string | null; message: string } {
    const normalized = rawValue.trim();
    const directCode = normalized.toUpperCase();

    if (QrScannerComponent.codePattern.test(directCode)) {
      return { code: directCode, message: '' };
    }

    try {
      const payload = JSON.parse(normalized) as { event?: unknown; accreditation?: unknown };

      if (payload.event !== QrScannerComponent.eventId) {
        return { code: null, message: 'El QR corresponde a otro evento.' };
      }

      const code =
        typeof payload.accreditation === 'string' ? payload.accreditation.trim().toUpperCase() : '';

      if (QrScannerComponent.codePattern.test(code)) {
        return { code, message: '' };
      }
    } catch {
      // El valor tampoco era un código directo; se informa como inválido abajo.
    }

    return {
      code: null,
      message: 'No se encontró una acreditación válida para la Asamblea Nacional 2026.',
    };
  }

  private feedbackFromError(caught: unknown, code: string): ScanFeedback {
    const error = caught instanceof HttpErrorResponse ? caught : null;
    const body =
      error && typeof error.error === 'object' && error.error !== null
        ? (error.error as CheckInResponse)
        : null;
    const validationMessage = body?.errors?.['code']?.[0];
    const message = validationMessage || body?.message;

    if (error?.status === 409 && body?.status === 'already_checked_in') {
      return {
        kind: 'already',
        title: 'QR ya utilizado',
        message: message || 'Esta persona ya había sido acreditada.',
        code: body.code || code,
        fullName: body.full_name,
        checkedInAt: body.checked_in_at,
      };
    }

    if (error?.status === 401) {
      this.removeSavedToken();
      return {
        kind: 'unauthorized',
        title: 'Clave incorrecta',
        message: message || 'Verifica la clave de operador e intenta nuevamente.',
        code,
      };
    }

    if (error?.status === 404 || error?.status === 422) {
      return {
        kind: 'invalid',
        title: 'Acreditación no válida',
        message: message || 'El código no existe o no tiene un formato válido.',
        code,
      };
    }

    return {
      kind: 'error',
      title: 'No se pudo validar',
      message:
        error?.status === 0
          ? 'No hay conexión con el servidor. Revisa la red antes de intentar otra vez.'
          : message || 'Ocurrió un error inesperado. Intenta nuevamente.',
      code,
    };
  }

  private persistTokenForSession(): void {
    try {
      if (this.rememberToken() && this.operatorToken().trim()) {
        window.sessionStorage.setItem(
          QrScannerComponent.sessionTokenKey,
          this.operatorToken().trim(),
        );
      } else {
        window.sessionStorage.removeItem(QrScannerComponent.sessionTokenKey);
      }
    } catch {
      // El almacenamiento es opcional y nunca impide la acreditación.
    }
  }

  private async getCodeReader(): Promise<BrowserQRCodeReader> {
    if (!this.codeReader) {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      this.codeReader = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 180,
        delayBetweenScanSuccess: 900,
      });
    }

    return this.codeReader;
  }

  private removeSavedToken(): void {
    this.rememberToken.set(false);
    try {
      window.sessionStorage.removeItem(QrScannerComponent.sessionTokenKey);
    } catch {
      // Sin acción: la clave seguirá únicamente en memoria.
    }
  }
}
