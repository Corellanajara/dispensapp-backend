import { v4 as uuid } from 'uuid';
import type {
  CallbackEvent,
  ISignatureProvider,
  ProviderInfo,
  RequestSignatureParams,
  SignatureInitResult,
  SignatureStatus,
  SignatureStatusResult,
} from '../types';

/**
 * Proveedor de firma de prueba para desarrollo local. No tiene validez legal.
 * La firma se completa sola a los 3 segundos y el "PDF firmado" es el mismo archivo subido.
 * Guarda el estado en memoria: se pierde al reiniciar el servidor.
 */

interface MockSignature {
  signatureId: string;
  status: SignatureStatus;
  signerName: string;
  signerRut?: string;
  signedAt?: Date;
}

const signatures = new Map<string, MockSignature>();

export class MockSignatureProvider implements ISignatureProvider {
  readonly name = 'mock';
  readonly requiresCertificate = false;

  info(): ProviderInfo {
    return {
      name: this.name,
      configurado: true,
      faltantes: [],
      requiereCertificado: false,
      validezLegal: false,
    };
  }

  async requestSignature(params: RequestSignatureParams): Promise<SignatureInitResult> {
    const signatureId = `sig_${uuid().slice(0, 12)}`;
    signatures.set(signatureId, {
      signatureId,
      status: 'enviado',
      signerName: params.signer.name,
      signerRut: params.signer.rut,
    });

    setTimeout(() => {
      const s = signatures.get(signatureId);
      if (s && s.status === 'enviado') {
        s.status = 'firmado';
        s.signedAt = new Date();
      }
    }, 3000);

    return {
      success: true,
      signatureId,
      status: 'enviado',
      message: 'Firma de prueba enviada: se completa sola en unos segundos (sin validez legal).',
    };
  }

  async getSignatureStatus(signatureId: string): Promise<SignatureStatusResult> {
    const s = signatures.get(signatureId);
    if (!s) return { signatureId, status: 'error', message: 'Firma de prueba no encontrada (¿se reinició el servidor?).' };
    return {
      signatureId,
      status: s.status,
      signedBy: s.status === 'firmado' ? s.signerName : undefined,
      signerRut: s.status === 'firmado' ? s.signerRut : undefined,
      signedAt: s.signedAt,
      message: s.status === 'firmado' ? `Firmado por ${s.signerName} (prueba)` : `Estado: ${s.status}`,
    };
  }

  async cancelSignature(signatureId: string): Promise<{ success: boolean; message: string }> {
    const s = signatures.get(signatureId);
    if (s && s.status !== 'firmado') s.status = 'cancelado';
    return { success: true, message: 'Firma de prueba cancelada.' };
  }

  async handleCallback(data: Record<string, unknown>): Promise<CallbackEvent> {
    const signatureId = String(data.signatureId ?? '');
    const s = signatures.get(signatureId);
    if (!s) return { tipo: 'ignorado', message: 'Firma de prueba no encontrada.' };
    s.status = (data.status as SignatureStatus) || 'firmado';
    if (s.status === 'firmado') s.signedAt = new Date();
    return { tipo: 'firma', ...(await this.getSignatureStatus(signatureId)) };
  }
}
