import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Component, ElementRef, ViewChild, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import QRCode from 'qrcode';
import { API_BASE_URL } from '../api.config';

type AdminProfile = {
  id: number;
  name: string;
  username: string;
  department: string;
  quota_limit: number;
  quota_used: number;
  quota_remaining: number;
  quota_exhausted: boolean;
};

type LoginResponse = {
  token: string;
  expires_at: string;
  admin: AdminProfile;
};

type AdminResponse = {
  admin: AdminProfile;
};

type RegistrationResponse = {
  code?: string;
  admin?: AdminProfile;
  error?: string;
};

type ApiErrorResponse = {
  code?: string;
  error?: string;
  message?: string;
  errors?: Record<string, string[]>;
  admin?: AdminProfile;
};

type Ticket = {
  code: string;
  qr: string;
  fullName: string;
};

@Component({
  selector: 'app-admin-registration',
  imports: [ReactiveFormsModule],
  templateUrl: './admin-registration.component.html',
  styleUrl: './admin-registration.component.css',
})
export class AdminRegistrationComponent {
  @ViewChild('cameraInput') private cameraInput?: ElementRef<HTMLInputElement>;
  @ViewChild('galleryInput') private galleryInput?: ElementRef<HTMLInputElement>;
  private static readonly sessionTokenKey = 'apb-admin-access-token';
  private static readonly allowedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  private static readonly maxPhotoBytes = 5 * 1024 * 1024;

  private readonly formBuilder = inject(FormBuilder);
  private readonly http = inject(HttpClient);

  readonly maxBirthDate = new Date().toISOString().slice(0, 10);
  readonly restoringSession = signal(true);
  readonly loggingIn = signal(false);
  readonly submitting = signal(false);
  readonly loginError = signal('');
  readonly registrationError = signal('');
  readonly admin = signal<AdminProfile | null>(null);
  readonly ticket = signal<Ticket | null>(null);
  readonly photoFile = signal<File | null>(null);
  readonly photoPreview = signal('');
  readonly photoError = signal('');

  private readonly accessToken = signal('');

  readonly canRegister = computed(() => {
    const profile = this.admin();
    return !!profile && !profile.quota_exhausted && profile.quota_remaining > 0;
  });

  readonly loginForm = this.formBuilder.nonNullable.group({
    username: ['', [Validators.required, Validators.maxLength(50)]],
    password: ['', [Validators.required, Validators.maxLength(200)]],
  });

  readonly registrationForm = this.formBuilder.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(160)]],
    phone: ['', [Validators.required, Validators.pattern(/^[+0-9 ()-]{7,20}$/)]],
    identityNumber: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9 .-]{5,20}$/)]],
    birthDate: ['', Validators.required],
    consent: [false, Validators.requiredTrue],
  });

  constructor() {
    void this.restoreSession();
  }

  async login(): Promise<void> {
    this.loginError.set('');
    this.loginForm.markAllAsTouched();

    if (this.loginForm.invalid) {
      this.loginError.set('Ingresa tu usuario y contraseña.');
      return;
    }

    this.loggingIn.set(true);

    try {
      const value = this.loginForm.getRawValue();
      const response = await firstValueFrom(
        this.http.post<LoginResponse>(`${API_BASE_URL}/api/admin/login`, {
          username: value.username.trim().toLowerCase(),
          password: value.password,
        }),
      );

      this.accessToken.set(response.token);
      this.admin.set(response.admin);
      this.writeSessionToken(response.token);
      this.loginForm.reset({ username: '', password: '' });
    } catch (caught) {
      this.loginError.set(this.errorMessage(caught, 'No se pudo iniciar sesión.'));
    } finally {
      this.loggingIn.set(false);
    }
  }

  async logout(): Promise<void> {
    const token = this.accessToken();

    try {
      if (token) {
        await firstValueFrom(
          this.http.post<void>(`${API_BASE_URL}/api/admin/logout`, null, {
            headers: this.authorizationHeaders(token),
          }),
        );
      }
    } catch {
      // El cierre local continúa aunque el servidor no esté disponible.
    } finally {
      this.clearSession();
    }
  }

  async register(): Promise<void> {
    this.registrationError.set('');
    this.photoError.set('');
    this.registrationForm.markAllAsTouched();

    if (!this.canRegister()) {
      this.registrationError.set('Tu cupo de registros se encuentra agotado.');
      return;
    }

    const photo = this.photoFile();
    if (this.registrationForm.invalid || !photo) {
      if (!photo) {
        this.photoError.set('Selecciona o toma una fotografía para continuar.');
      }
      this.registrationError.set('Revisa los campos marcados antes de continuar.');
      return;
    }

    const value = this.registrationForm.getRawValue();
    const fullName = value.fullName.trim().replace(/\s+/g, ' ');
    if (fullName.split(' ').length < 2) {
      this.registrationError.set('Ingresa el nombre y apellido de la persona.');
      return;
    }

    const token = this.accessToken();
    if (!token) {
      this.clearSession('Tu sesión venció. Ingresa nuevamente.');
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
        this.http.post<RegistrationResponse>(`${API_BASE_URL}/api/admin/registrations`, payload, {
          headers: this.authorizationHeaders(token),
        }),
      );

      if (!result.code) {
        throw new Error(result.error || 'No se pudo completar el registro.');
      }

      if (result.admin) {
        this.admin.set(result.admin);
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

      this.ticket.set({ code: result.code, qr, fullName });
      this.clearPhoto();
      window.setTimeout(
        () =>
          document.getElementById('admin-accreditation')?.scrollIntoView({ behavior: 'smooth' }),
        80,
      );
    } catch (caught) {
      const error = caught instanceof HttpErrorResponse ? caught : null;
      const body = this.errorBody(caught);

      if (body?.admin) {
        this.admin.set(body.admin);
      }

      if (error?.status === 401 || error?.status === 403) {
        this.clearSession(body?.error || 'Tu sesión venció. Ingresa nuevamente.');
        return;
      }

      this.registrationError.set(
        this.errorMessage(caught, 'No se pudo completar el registro. Intenta nuevamente.'),
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

    if (!AdminRegistrationComponent.allowedPhotoTypes.has(file.type)) {
      this.photoError.set('La fotografía debe estar en formato JPG, PNG o WEBP.');
      input.value = '';
      return;
    }

    if (file.size > AdminRegistrationComponent.maxPhotoBytes) {
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

    if (this.cameraInput) {
      this.cameraInput.nativeElement.value = '';
    }

    if (this.galleryInput) {
      this.galleryInput.nativeElement.value = '';
    }
  }

  photoSizeLabel(): string {
    const bytes = this.photoFile()?.size ?? 0;
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  quotaPercentage(): number {
    const profile = this.admin();
    if (!profile || profile.quota_limit <= 0) {
      return 100;
    }

    return Math.min(100, Math.round((profile.quota_used / profile.quota_limit) * 100));
  }

  resetRegistration(): void {
    this.ticket.set(null);
    this.registrationError.set('');
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
      () =>
        document.getElementById('admin-registration-form')?.scrollIntoView({ behavior: 'smooth' }),
      50,
    );
  }

  printTicket(): void {
    window.print();
  }

  private async restoreSession(): Promise<void> {
    const token = this.readSessionToken();

    if (!token) {
      this.restoringSession.set(false);
      return;
    }

    this.accessToken.set(token);

    try {
      const response = await firstValueFrom(
        this.http.get<AdminResponse>(`${API_BASE_URL}/api/admin/me`, {
          headers: this.authorizationHeaders(token),
        }),
      );
      this.admin.set(response.admin);
    } catch (caught) {
      const status = caught instanceof HttpErrorResponse ? caught.status : 0;
      if (status === 401 || status === 403) {
        this.clearSession('Tu sesión venció. Ingresa nuevamente.');
      } else {
        this.loginError.set('No se pudo conectar con el servidor. Intenta nuevamente.');
      }
    } finally {
      this.restoringSession.set(false);
    }
  }

  private authorizationHeaders(token = this.accessToken()): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  private errorBody(caught: unknown): ApiErrorResponse | null {
    if (caught instanceof HttpErrorResponse && typeof caught.error === 'object' && caught.error) {
      return caught.error as ApiErrorResponse;
    }

    return null;
  }

  private errorMessage(caught: unknown, fallback: string): string {
    const body = this.errorBody(caught);
    const validationMessage = body?.errors ? Object.values(body.errors).flat()[0] : null;

    if (body?.error || validationMessage || body?.message) {
      return body?.error || validationMessage || body?.message || fallback;
    }

    if (caught instanceof HttpErrorResponse && caught.status === 0) {
      return 'No hay conexión con el servidor. Revisa la red e intenta nuevamente.';
    }

    return caught instanceof Error ? caught.message : fallback;
  }

  private readSessionToken(): string {
    try {
      return window.sessionStorage.getItem(AdminRegistrationComponent.sessionTokenKey) || '';
    } catch {
      return '';
    }
  }

  private writeSessionToken(token: string): void {
    try {
      window.sessionStorage.setItem(AdminRegistrationComponent.sessionTokenKey, token);
    } catch {
      // La sesión sigue activa en memoria aunque el navegador bloquee sessionStorage.
    }
  }

  private clearSession(message = ''): void {
    this.accessToken.set('');
    this.admin.set(null);
    this.ticket.set(null);
    this.clearPhoto();

    try {
      window.sessionStorage.removeItem(AdminRegistrationComponent.sessionTokenKey);
    } catch {
      // No se requiere ninguna acción adicional.
    }

    if (message) {
      this.loginError.set(message);
    }
  }
}
