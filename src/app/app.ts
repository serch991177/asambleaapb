import { Component, ElementRef, ViewChild, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import QRCode from 'qrcode';
import { QrScannerComponent } from './scanner/qr-scanner.component';
import { API_BASE_URL } from './api.config';

type RegistrationResponse = {
  code?: string;
  error?: string;
};

type ApiErrorResponse = {
  error?: string;
  message?: string;
  errors?: Record<string, string[]>;
};

type Ticket = {
  code: string;
  qr: string;
  fullName: string;
};

@Component({
  selector: 'app-root',
  imports: [ReactiveFormsModule, QrScannerComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  @ViewChild('photoInput') private photoInput?: ElementRef<HTMLInputElement>;

  private static readonly allowedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  private static readonly maxPhotoBytes = 5 * 1024 * 1024;

  private readonly formBuilder = inject(FormBuilder);
  private readonly http = inject(HttpClient);

  readonly maxBirthDate = new Date().toISOString().slice(0, 10);
  readonly submitting = signal(false);
  readonly error = signal('');
  readonly ticket = signal<Ticket | null>(null);
  readonly photoFile = signal<File | null>(null);
  readonly photoPreview = signal('');
  readonly photoError = signal('');

  readonly registrationForm = this.formBuilder.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(160)]],
    phone: ['', [Validators.required, Validators.pattern(/^[+0-9 ()-]{7,20}$/)]],
    identityNumber: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9 .-]{5,20}$/)]],
    birthDate: ['', Validators.required],
    consent: [false, Validators.requiredTrue],
  });

  async register(): Promise<void> {
    this.error.set('');
    this.photoError.set('');
    this.registrationForm.markAllAsTouched();

    const photo = this.photoFile();
    if (this.registrationForm.invalid || !photo) {
      if (!photo) {
        this.photoError.set('Selecciona o toma una fotografía para continuar.');
      }
      this.error.set('Revisa los campos marcados antes de continuar.');
      return;
    }

    const value = this.registrationForm.getRawValue();
    const fullName = value.fullName.trim().replace(/\s+/g, ' ');
    if (fullName.split(' ').length < 2) {
      this.error.set('Ingresa tu nombre y apellido para continuar.');
      return;
    }

    this.submitting.set(true);
    try {
      const payload = new FormData();
      payload.append('full_name', fullName);
      payload.append('email', value.email.trim().toLowerCase());
      payload.append('phone', value.phone.trim());
      payload.append('identity_number', value.identityNumber.trim());
      payload.append('birth_date', value.birthDate);
      payload.append('consent', value.consent ? '1' : '0');
      payload.append('photo', photo, photo.name);

      const result = await firstValueFrom(
        this.http.post<RegistrationResponse>(`${API_BASE_URL}/api/register`, payload),
      );

      if (!result.code) {
        throw new Error(result.error || 'No pudimos completar el registro.');
      }

      const qr = await QRCode.toDataURL(
        JSON.stringify({
          event: 'ASAMBLEA-NACIONAL-2026',
          accreditation: result.code,
        }),
        {
          width: 720,
          margin: 3,
          errorCorrectionLevel: 'H',
          color: { dark: '#2d0b31', light: '#ffffff' },
        },
      );

      this.ticket.set({
        code: result.code,
        qr,
        fullName,
      });
      this.clearPhoto();
      window.setTimeout(
        () => document.getElementById('acreditacion')?.scrollIntoView({ behavior: 'smooth' }),
        80,
      );
    } catch (caught) {
      const responseBody =
        typeof caught === 'object' && caught !== null && 'error' in caught
          ? (caught.error as ApiErrorResponse | null)
          : null;
      const validationMessage = responseBody?.errors
        ? Object.values(responseBody.errors).flat()[0]
        : null;
      const serverMessage =
        responseBody?.error || validationMessage || responseBody?.message || null;
      this.error.set(
        serverMessage ||
          (caught instanceof Error
            ? caught.message
            : 'No pudimos completar el registro. Intenta nuevamente.'),
      );
    } finally {
      this.submitting.set(false);
    }
  }

  onPhotoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;

    this.photoFile.set(null);
    this.photoPreview.set('');
    this.photoError.set('');

    if (!file) {
      return;
    }

    if (!App.allowedPhotoTypes.has(file.type)) {
      this.photoError.set('La fotografía debe estar en formato JPG, PNG o WEBP.');
      input.value = '';
      return;
    }

    if (file.size > App.maxPhotoBytes) {
      this.photoError.set('La fotografía no puede superar los 5 MB.');
      input.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      this.photoFile.set(file);
      this.photoPreview.set(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      this.photoError.set('No se pudo leer la fotografía seleccionada.');
      input.value = '';
    };
    reader.readAsDataURL(file);
  }

  clearPhoto(): void {
    this.photoFile.set(null);
    this.photoPreview.set('');
    this.photoError.set('');

    if (this.photoInput) {
      this.photoInput.nativeElement.value = '';
    }
  }

  photoSizeLabel(): string {
    const bytes = this.photoFile()?.size ?? 0;
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  resetRegistration(): void {
    this.ticket.set(null);
    this.error.set('');
    this.clearPhoto();
    this.registrationForm.reset({
      fullName: '',
      email: '',
      phone: '',
      identityNumber: '',
      birthDate: '',
      consent: false,
    });
    window.setTimeout(
      () => document.getElementById('registro')?.scrollIntoView({ behavior: 'smooth' }),
      50,
    );
  }

  printTicket(): void {
    window.print();
  }
}
