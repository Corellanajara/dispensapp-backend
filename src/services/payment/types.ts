/**
 * Interfaces agnósticas de proveedor para integración con
 * terminales POS físicos (Geonet, Webpay, BCI, etc.).
 *
 * Para agregar un nuevo proveedor:
 *   1. Crear archivo en ./providers/<nombre>.ts
 *   2. Implementar IPOSPaymentProvider
 *   3. Registrar en ./index.ts con registerProvider()
 *   4. Setear POS_PAYMENT_PROVIDER=<nombre> en .env
 */

// ─── Tipos base ────────────────────────────────────────────

export type PaymentMethod = 'debito' | 'credito';

export type PaymentStatus =
  | 'pendiente'
  | 'procesando'
  | 'aprobado'
  | 'rechazado'
  | 'cancelado'
  | 'error';

// ─── Parámetros de entrada ─────────────────────────────────

export interface InitiatePaymentParams {
  /** ID interno de la orden */
  orderId: string;
  /** Monto en CLP (entero, sin decimales) */
  amount: number;
  /** Método de pago */
  method: PaymentMethod;
  /** Número de cuotas (solo crédito, 0 = sin cuotas) */
  installments?: number;
  /** Referencia legible (ej. numeroPedido) */
  reference: string;
  /** Metadata adicional que el proveedor pueda requerir */
  metadata?: Record<string, unknown>;
}

// ─── Resultados ────────────────────────────────────────────

export interface PaymentInitResult {
  /** true si la solicitud al terminal fue aceptada */
  success: boolean;
  /** ID de transacción asignado por el proveedor */
  transactionId: string;
  /** Estado inicial */
  status: PaymentStatus;
  /** Mensaje legible */
  message: string;
  /** Datos crudos del proveedor (para auditoría) */
  raw?: Record<string, unknown>;
}

export interface PaymentStatusResult {
  transactionId: string;
  status: PaymentStatus;
  /** Últimos 4 dígitos de la tarjeta */
  lastFourDigits?: string;
  /** Código de autorización del emisor */
  authorizationCode?: string;
  /** Monto confirmado */
  amount?: number;
  method?: PaymentMethod;
  installments?: number;
  message: string;
  raw?: Record<string, unknown>;
}

export interface PaymentCallbackData {
  /** Datos crudos recibidos en el webhook/callback */
  [key: string]: unknown;
}

export interface PaymentCallbackResult {
  transactionId: string;
  status: PaymentStatus;
  lastFourDigits?: string;
  authorizationCode?: string;
  amount?: number;
  method?: PaymentMethod;
  message: string;
}

// ─── Interfaz del proveedor ────────────────────────────────

export interface IPOSPaymentProvider {
  /** Nombre identificador del proveedor (ej. 'geonet', 'webpay', 'bci') */
  readonly name: string;

  /**
   * Envía la solicitud de cobro al terminal POS.
   * El terminal mostrará el monto y esperará la tarjeta.
   */
  initiatePayment(params: InitiatePaymentParams): Promise<PaymentInitResult>;

  /**
   * Consulta el estado de un pago previamente iniciado.
   * Útil para polling desde el frontend.
   */
  getPaymentStatus(transactionId: string): Promise<PaymentStatusResult>;

  /**
   * Cancela/reversa un pago en curso o recientemente aprobado.
   */
  cancelPayment(transactionId: string): Promise<{ success: boolean; message: string }>;

  /**
   * Procesa un callback/webhook del proveedor.
   * Normaliza la respuesta al formato interno.
   */
  handleCallback(data: PaymentCallbackData): Promise<PaymentCallbackResult>;
}
