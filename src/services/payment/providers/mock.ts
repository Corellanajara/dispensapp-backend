import { v4 as uuid } from 'uuid';
import type {
  IPOSPaymentProvider,
  InitiatePaymentParams,
  PaymentInitResult,
  PaymentStatusResult,
  PaymentCallbackData,
  PaymentCallbackResult,
  PaymentStatus,
} from '../types';

/**
 * Proveedor POS de prueba / desarrollo.
 * Simula el flujo completo sin hardware real.
 * Los pagos se aprueban automáticamente después de 2 segundos.
 */

interface MockTransaction {
  transactionId: string;
  status: PaymentStatus;
  amount: number;
  method: string;
  reference: string;
  createdAt: Date;
}

const transactions = new Map<string, MockTransaction>();

export class MockPOSProvider implements IPOSPaymentProvider {
  readonly name = 'mock';

  async initiatePayment(params: InitiatePaymentParams): Promise<PaymentInitResult> {
    const transactionId = `mock_${uuid().slice(0, 12)}`;

    const tx: MockTransaction = {
      transactionId,
      status: 'procesando',
      amount: params.amount,
      method: params.method,
      reference: params.reference,
      createdAt: new Date(),
    };
    transactions.set(transactionId, tx);

    // Simular aprobación automática en 2s
    setTimeout(() => {
      const stored = transactions.get(transactionId);
      if (stored && stored.status === 'procesando') {
        stored.status = 'aprobado';
      }
    }, 2000);

    return {
      success: true,
      transactionId,
      status: 'procesando',
      message: 'Pago iniciado en terminal (mock). Esperando tarjeta...',
    };
  }

  async getPaymentStatus(transactionId: string): Promise<PaymentStatusResult> {
    const tx = transactions.get(transactionId);
    if (!tx) {
      return {
        transactionId,
        status: 'error',
        message: 'Transacción no encontrada',
      };
    }

    return {
      transactionId,
      status: tx.status,
      lastFourDigits: tx.status === 'aprobado' ? '4242' : undefined,
      authorizationCode: tx.status === 'aprobado' ? `AUTH${Date.now().toString(36).toUpperCase()}` : undefined,
      amount: tx.amount,
      method: tx.method as 'debito' | 'credito',
      message: tx.status === 'aprobado'
        ? 'Pago aprobado (mock)'
        : tx.status === 'procesando'
          ? 'Esperando tarjeta en terminal...'
          : `Estado: ${tx.status}`,
    };
  }

  async cancelPayment(transactionId: string): Promise<{ success: boolean; message: string }> {
    const tx = transactions.get(transactionId);
    if (!tx) {
      return { success: false, message: 'Transacción no encontrada' };
    }
    if (tx.status === 'aprobado') {
      return { success: false, message: 'No se puede cancelar un pago ya aprobado. Use reversa.' };
    }
    tx.status = 'cancelado';
    return { success: true, message: 'Pago cancelado (mock)' };
  }

  async handleCallback(data: PaymentCallbackData): Promise<PaymentCallbackResult> {
    const transactionId = data.transactionId as string;
    const tx = transactions.get(transactionId);
    if (!tx) {
      return {
        transactionId: transactionId || 'unknown',
        status: 'error',
        message: 'Transacción no encontrada en callback',
      };
    }

    const newStatus = (data.status as PaymentStatus) || 'aprobado';
    tx.status = newStatus;

    return {
      transactionId,
      status: newStatus,
      lastFourDigits: '4242',
      authorizationCode: `AUTH${Date.now().toString(36).toUpperCase()}`,
      amount: tx.amount,
      method: tx.method as 'debito' | 'credito',
      message: `Callback procesado (mock): ${newStatus}`,
    };
  }
}
