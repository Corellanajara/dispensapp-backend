/**
 * Interfaces agnósticas de proveedor para integración con
 * servicios de firma electrónica (e-certchile, Thomas Signer,
 * Acepta, FirmaGob, etc.).
 *
 * Para agregar un nuevo proveedor:
 *   1. Crear archivo en ./providers/<nombre>.ts
 *   2. Implementar ISignatureProvider
 *   3. Registrar en ./index.ts con registerProvider()
 *   4. Setear SIGNATURE_PROVIDER=<nombre> en .env
 */

// ─── Tipos base ────────────────────────────────────────────

export type SignatureStatus =
  | 'pendiente'
  | 'enviado'
  | 'firmado'
  | 'rechazado'
  | 'expirado'
  | 'error';

// ─── Parámetros de entrada ─────────────────────────────────

export interface RequestSignatureParams {
  /** ID interno del documento */
  documentId: string;
  /** Nombre del documento (para mostrar al firmante) */
  documentName: string;
  /** Ruta o URL del archivo a firmar */
  documentPath: string;
  /** Datos del firmante */
  signer: {
    name: string;
    email: string;
    rut?: string;
  };
  /** Referencia legible (ej. numeroPedido) */
  reference: string;
  /** Mensaje personalizado para el firmante */
  message?: string;
  /** URL de callback cuando se complete la firma */
  callbackUrl?: string;
  /** Metadata adicional */
  metadata?: Record<string, unknown>;
}

// ─── Resultados ────────────────────────────────────────────

export interface SignatureInitResult {
  /** true si la solicitud fue aceptada por el proveedor */
  success: boolean;
  /** ID de firma asignado por el proveedor */
  signatureId: string;
  /** Estado inicial */
  status: SignatureStatus;
  /** URL para que el firmante realice la firma (si aplica) */
  signingUrl?: string;
  /** Mensaje legible */
  message: string;
  /** Datos crudos del proveedor */
  raw?: Record<string, unknown>;
}

export interface SignatureStatusResult {
  signatureId: string;
  status: SignatureStatus;
  /** Nombre de quien firmó */
  signedBy?: string;
  /** RUT del firmante */
  signerRut?: string;
  /** Fecha/hora de la firma */
  signedAt?: Date;
  /** Ruta o URL del documento firmado */
  signedDocumentUrl?: string;
  message: string;
  raw?: Record<string, unknown>;
}

export interface SignatureCallbackData {
  [key: string]: unknown;
}

export interface SignatureCallbackResult {
  signatureId: string;
  documentId: string;
  status: SignatureStatus;
  signedBy?: string;
  signerRut?: string;
  signedAt?: Date;
  signedDocumentUrl?: string;
  message: string;
}

// ─── Interfaz del proveedor ────────────────────────────────

export interface ISignatureProvider {
  /** Nombre identificador del proveedor (ej. 'ecertchile', 'acepta') */
  readonly name: string;

  /**
   * Solicita la firma electrónica de un documento.
   * Envía la solicitud al proveedor y devuelve el ID de seguimiento.
   */
  requestSignature(params: RequestSignatureParams): Promise<SignatureInitResult>;

  /**
   * Consulta el estado de una firma previamente solicitada.
   */
  getSignatureStatus(signatureId: string): Promise<SignatureStatusResult>;

  /**
   * Cancela una solicitud de firma pendiente.
   */
  cancelSignature(signatureId: string): Promise<{ success: boolean; message: string }>;

  /**
   * Procesa un callback/webhook del proveedor de firma.
   * Normaliza la respuesta al formato interno.
   */
  handleCallback(data: SignatureCallbackData): Promise<SignatureCallbackResult>;
}
