/**
 * Interfaces agnósticas de proveedor de firma electrónica.
 *
 * Para agregar un nuevo proveedor:
 *   1. Crear archivo en ./providers/<nombre>.ts
 *   2. Implementar ISignatureProvider
 *   3. Registrar en ./index.ts con registerProvider()
 *   4. Setear SIGNATURE_PROVIDER=<nombre> en .env
 */

import type { SignatureStatus } from '../../models/shared';

export type { SignatureStatus };

/** Error del proveedor con un mensaje que se puede mostrar al usuario. */
export class SignatureProviderError extends Error {
  constructor(
    message: string,
    public status = 502,
    public detalle?: { codigo?: string; trackingId?: string; mensajeProveedor?: string }
  ) {
    super(message);
  }
}

// ─── Parámetros de entrada ─────────────────────────────────

export interface SignerInfo {
  name: string;
  email: string;
  rut?: string;
}

export interface StampOptions {
  /** 1 = sello estándar · 2 = texto personalizado · 5 = sin estampa visible */
  tipoEstampa: 1 | 2 | 5;
  textoEstampa?: string;
  conQR: boolean;
  posicion?: { pagina: number; x: number; y: number } | null;
}

export interface RequestSignatureParams {
  /** ID interno del documento (subdocumento del paciente). */
  documentId: string;
  /** Nombre de archivo que verá el firmante (debe terminar en .pdf). */
  documentName: string;
  /** Contenido del PDF. */
  document: Buffer;
  signer: SignerInfo;
  /** Número de serie del certificado del firmante (proveedores con requiresCertificate). */
  certificateSerial?: string;
  /** Referencia legible (ej. RUT - tipo de documento). */
  reference: string;
  /** A dónde vuelve el firmante al terminar. */
  redirectUrl: string;
  estampa: StampOptions;
}

export interface CertificateRequestParams {
  rut: string;
  /** Número de serie (número de documento) de la cédula de identidad. */
  serialNumber: string;
  /** Teléfono con código de país, sin espacios (ej. +56912345678). */
  phone: string;
  /** Comuna escrita como la espera el proveedor. */
  comuna: string;
  email: string;
  years: 1 | 2 | 3;
  /** A dónde vuelve el usuario al terminar el enrolamiento. */
  redirectUrl: string;
}

// ─── Resultados ────────────────────────────────────────────

export interface SignatureInitResult {
  success: boolean;
  /** ID de la firma en el proveedor (con este ID llegan las notificaciones). */
  signatureId: string;
  status: SignatureStatus;
  /** URL donde el firmante completa la firma. */
  signingUrl?: string;
  message: string;
  raw?: Record<string, unknown>;
}

export interface SignatureStatusResult {
  signatureId: string;
  status: SignatureStatus;
  signedBy?: string;
  signerRut?: string;
  signedAt?: Date;
  /** URL temporal para descargar el PDF firmado. */
  signedDocumentUrl?: string;
  message: string;
  raw?: Record<string, unknown>;
}

export interface CertificateRequestResult {
  token: string;
  /** URL donde el usuario valida su identidad para obtener el certificado. */
  enrollUrl: string;
  message: string;
}

/** Notificación del proveedor, ya normalizada. */
export type CallbackEvent =
  | ({ tipo: 'firma' } & SignatureStatusResult)
  | {
      tipo: 'certificado';
      estado: 'activo' | 'fallido' | 'en_curso';
      token?: string;
      email?: string;
      numeroSerie?: string;
      message: string;
    }
  | { tipo: 'ignorado'; message: string };

export interface ProviderInfo {
  name: string;
  /** true si las credenciales necesarias están configuradas. */
  configurado: boolean;
  faltantes: string[];
  ambiente?: 'pruebas' | 'produccion';
  baseUrl?: string;
  /** true si el firmante necesita un certificado propio antes de firmar. */
  requiereCertificado: boolean;
  /** true si las firmas tienen validez legal (el mock no). */
  validezLegal: boolean;
}

// ─── Interfaz del proveedor ────────────────────────────────

export interface ISignatureProvider {
  readonly name: string;
  /** El firmante necesita un certificado propio (Signapis: firma electrónica avanzada). */
  readonly requiresCertificate: boolean;

  info(): ProviderInfo;

  requestSignature(params: RequestSignatureParams): Promise<SignatureInitResult>;
  getSignatureStatus(signatureId: string): Promise<SignatureStatusResult>;
  cancelSignature(signatureId: string): Promise<{ success: boolean; message: string }>;

  /** Normaliza una notificación (webhook) del proveedor. */
  handleCallback(data: Record<string, unknown>): Promise<CallbackEvent>;

  // ── Certificados del firmante (solo si requiresCertificate) ──
  /** Número de serie de un certificado activo del firmante, o null si no tiene. */
  findActiveCertificate?(email: string): Promise<string | null>;
  requestCertificate?(params: CertificateRequestParams): Promise<CertificateRequestResult>;

  // ── Herramientas de administración ──
  testConnection?(): Promise<{ ok: boolean; message: string }>;
  /** Registra en el proveedor la URL del webhook, que enviará el header X-Callback-Secret. */
  configureWebhook?(url: string, secret: string): Promise<{ message: string }>;
  getWebhook?(): Promise<{ url?: string; authType?: string } | null>;
  testWebhook?(): Promise<{ message: string }>;
}
