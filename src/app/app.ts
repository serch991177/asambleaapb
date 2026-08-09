import { Component, inject, signal } from '@angular/core';
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
  private readonly formBuilder = inject(FormBuilder);
  private readonly http = inject(HttpClient);

  readonly maxBirthDate = new Date().toISOString().slice(0, 10);
  readonly submitting = signal(false);
  readonly error = signal('');
  readonly ticket = signal<Ticket | null>(null);

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
    this.registrationForm.markAllAsTouched();

    if (this.registrationForm.invalid) {
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
      const result = await firstValueFrom(
        this.http.post<RegistrationResponse>(`${API_BASE_URL}/api/register`, {
          full_name: fullName,
          email: value.email.trim().toLowerCase(),
          phone: value.phone.trim(),
          identity_number: value.identityNumber.trim(),
          birth_date: value.birthDate,
          consent: value.consent,
        }),
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
      window.setTimeout(
        () => document.getElementById('acreditacion')?.scrollIntoView({ behavior: 'smooth' }),
        80,
      );
    } catch (caught) {
      const responseBody =
        typeof caught === 'object' && caught !== null && 'error' in caught
          ? (caught.error as { error?: string; message?: string } | null)
          : null;
      const serverMessage = responseBody?.error || responseBody?.message || null;
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

  resetRegistration(): void {
    this.ticket.set(null);
    this.error.set('');
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
