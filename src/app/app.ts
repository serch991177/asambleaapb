import { Component } from '@angular/core';
import { AdminRegistrationComponent } from './admin-registration/admin-registration.component';
import { QrScannerComponent } from './scanner/qr-scanner.component';

@Component({
  selector: 'app-root',
  imports: [AdminRegistrationComponent, QrScannerComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly isAdminModule = window.location.pathname.replace(/\/+$/, '') === '/administracion';
}
