import axios, { AxiosError, AxiosInstance, Method } from 'axios';
import { env } from '../../../config/env';
import {
  SignatureProviderError,
  type CallbackEvent,
  type CertificateRequestParams,
  type CertificateRequestResult,
  type ISignatureProvider,
  type ProviderInfo,
  type RequestSignatureParams,
  type SignatureInitResult,
  type SignatureStatus,
  type SignatureStatusResult,
} from '../types';

/**
 * Signapis — firma electrónica avanzada (https://fear-docs.signapis.com).
 *
 * Flujo:
 *  1. El firmante necesita un certificado propio. Si no tiene, se pide con /v2/requestCertificate
 *     y el usuario valida su identidad en la URL que entrega Signapis (Clave Única, preguntas, etc.).
 *     Signapis avisa por webhook (CERTIFICATE_CREATED) con el número de serie.
 *  2. Se sube el PDF con /v2/documents → documentId.
 *  3. Se pide la firma con /v2/requestSign → signUrl. El firmante entra, ingresa su clave y un código OTP.
 *  4. Signapis avisa por webhook (SIGN / COMPLETE) con un enlace temporal (30 min) al PDF firmado.
 *
 * Ambientes: SIGNAPIS_AMBIENTE=pruebas (sandbox) o produccion. Cada uno tiene su propia API key y usuario.
 */

const URLS = {
  pruebas: 'https://fear-api-sandbox.signapis.com',
  produccion: 'https://fear-api.signapis.com',
} as const;

const MAX_PDF_BYTES = 5 * 1024 * 1024; // límite de Signapis para documentos en base64
const EMAIL_INVALIDO = /[^\x00-\x7F]|[&'%$!"()*#=,;<>]|\.\./;

/** Mensajes de Signapis traducidos para mostrar al usuario. */
const TRADUCCIONES: Array<[RegExp, string, string?]> = [
  [/invalid credentials/i, 'Usuario o contraseña de Signapis incorrectos (revisa SIGNAPIS_EMAIL y SIGNAPIS_PASSWORD).', 'CREDENCIALES'],
  [/^forbidden$/i, 'Signapis rechazó la API key (revisa SIGNAPIS_API_KEY y que corresponda al ambiente).', 'API_KEY'],
  [/invalid commune/i, 'Signapis no reconoce la comuna del paciente.', 'COMUNA'],
  [/civil registry failed|invalid rut/i, 'El Registro Civil no validó el RUT con ese número de serie de cédula. Revisa ambos datos.', 'REGISTRO_CIVIL'],
  [/civil registry not available/i, 'El Registro Civil no está disponible en este momento. Intenta más tarde.', 'REGISTRO_CIVIL'],
  [/registered with another identification/i, 'Ese correo ya está registrado en Signapis con otro RUT.', 'EMAIL_OTRO_RUT'],
  [/single-use certificate/i, 'El certificado de un solo uso del firmante ya se usó o venció.', 'CERTIFICADO_INVALIDO'],
  [/certificate is (suspended|revoked|expired)|certificate does not exist|certificate not found/i, 'El certificado de firma del paciente no está activo. Debe obtener uno nuevo.', 'CERTIFICADO_INVALIDO'],
  [/password protected/i, 'El PDF tiene contraseña. Sube una versión sin protección.', 'PDF'],
  [/invalid document$/i, 'Signapis no aceptó el archivo. Debe ser un PDF válido de hasta 5 MB.', 'PDF'],
  [/user and document do not match/i, 'El correo del firmante no coincide con el del documento.', 'FIRMANTE'],
  [/invalid request body by signature type/i, 'La configuración de la estampa no es válida (revisa el texto de la firma).', 'ESTAMPA'],
];

function traducir(mensaje: string): { message: string; codigo?: string } {
  for (const [re, texto, codigo] of TRADUCCIONES) {
    if (re.test(mensaje)) return { message: texto, codigo };
  }
  return { message: `Signapis respondió: ${mensaje}` };
}

/** Nombre de archivo aceptado por Signapis: sin caracteres especiales, termina en .pdf, máx. 100. */
function nombrePdf(nombre: string): string {
  const base = nombre
    .replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return `${base || 'documento'}.pdf`;
}

interface RespuestaSignapis<T = unknown> {
  code?: number;
  message?: string;
  trackingId?: string;
  data?: T;
}

type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function fecha(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const PASOS_ENROLAMIENTO: Record<string, string> = {
  CIVIL_REGISTRY: 'Registro Civil',
  CLAVE_UNICA: 'Clave Única',
  NFC_VALIDATION: 'validación con la cédula (NFC)',
  BURO_VALIDATION: 'preguntas de validación',
  BANK_TRANSFER_VALIDATION: 'transferencia bancaria',
  BANK_TRANSFER_REFUNDED: 'reembolso de la transferencia',
  OTP_VALIDATION: 'código de verificación',
};

export class SignapisProvider implements ISignatureProvider {
  readonly name = 'signapis';
  readonly requiresCertificate = true;

  private http: AxiosInstance;
  private token: { valor: string; expira: number } | null = null;
  private login$: Promise<string> | null = null;

  constructor() {
    this.http = axios.create({ timeout: 25_000 });
  }

  private get baseUrl(): string {
    return (env.SIGNAPIS_BASE_URL || URLS[env.SIGNAPIS_AMBIENTE]).replace(/\/+$/, '');
  }

  info(): ProviderInfo {
    const faltantes = (
      [
        ['SIGNAPIS_API_KEY', env.SIGNAPIS_API_KEY],
        ['SIGNAPIS_EMAIL', env.SIGNAPIS_EMAIL],
        ['SIGNAPIS_PASSWORD', env.SIGNAPIS_PASSWORD],
        ['SIGNATURE_CALLBACK_SECRET', env.SIGNATURE_CALLBACK_SECRET],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return {
      name: this.name,
      configurado: faltantes.length === 0,
      faltantes,
      ambiente: env.SIGNAPIS_AMBIENTE,
      baseUrl: this.baseUrl,
      requiereCertificado: true,
      validezLegal: true,
    };
  }

  // ─── HTTP ────────────────────────────────────────────────

  private errorDe(err: unknown, accion: string): SignatureProviderError {
    if (err instanceof SignatureProviderError) return err;
    const ax = err as AxiosError<RespuestaSignapis>;
    const body = ax.response?.data;
    const mensajeProveedor = typeof body?.message === 'string' ? body.message : undefined;
    if (mensajeProveedor) {
      const t = traducir(mensajeProveedor);
      const status = ax.response?.status && ax.response.status < 500 ? 400 : 502;
      return new SignatureProviderError(t.message, status, {
        codigo: t.codigo,
        trackingId: body?.trackingId,
        mensajeProveedor,
      });
    }
    if (ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT') {
      return new SignatureProviderError(`Signapis no respondió a tiempo al ${accion}. Intenta de nuevo.`, 504);
    }
    return new SignatureProviderError(`No se pudo conectar con Signapis al ${accion}.`, 502, {
      mensajeProveedor: ax.message,
    });
  }

  private asegurarConfigurado(): void {
    const { faltantes } = this.info();
    const sinCredenciales = faltantes.filter((f) => f !== 'SIGNATURE_CALLBACK_SECRET');
    if (sinCredenciales.length) {
      throw new SignatureProviderError(
        `Faltan variables de entorno de Signapis: ${sinCredenciales.join(', ')}.`,
        503,
        { codigo: 'SIN_CONFIGURAR' }
      );
    }
  }

  private async obtenerToken(forzar = false): Promise<string> {
    if (!forzar && this.token && this.token.expira > Date.now()) return this.token.valor;
    if (this.login$) return this.login$;

    this.asegurarConfigurado();
    this.login$ = (async () => {
      try {
        const { data } = await this.http.post<RespuestaSignapis<{ accessToken: string; expiryTime?: number }>>(
          `${this.baseUrl}/v2/login`,
          { email: env.SIGNAPIS_EMAIL, password: env.SIGNAPIS_PASSWORD },
          { headers: { 'x-api-key': env.SIGNAPIS_API_KEY } }
        );
        const valor = data.data?.accessToken;
        if (!valor) throw new SignatureProviderError('Signapis no entregó un token de acceso.', 502);
        // El token dura 120 min; se renueva 5 min antes.
        const segundos = Math.max(60, (data.data?.expiryTime ?? 7200) - 300);
        this.token = { valor, expira: Date.now() + segundos * 1000 };
        return valor;
      } catch (err) {
        throw this.errorDe(err, 'iniciar sesión');
      } finally {
        this.login$ = null;
      }
    })();
    return this.login$;
  }

  private async llamar<T>(method: Method, path: string, accion: string, data?: unknown): Promise<RespuestaSignapis<T>> {
    const enviar = async (token: string) =>
      this.http.request<RespuestaSignapis<T>>({
        method,
        url: `${this.baseUrl}${path}`,
        data,
        headers: { 'x-api-key': env.SIGNAPIS_API_KEY, Authorization: `Bearer ${token}` },
        maxBodyLength: 20 * 1024 * 1024,
      });
    try {
      try {
        return (await enviar(await this.obtenerToken())).data;
      } catch (err) {
        // Token vencido o revocado: se pide uno nuevo y se reintenta una vez.
        if ((err as AxiosError).response?.status === 401) {
          return (await enviar(await this.obtenerToken(true))).data;
        }
        throw err;
      }
    } catch (err) {
      throw this.errorDe(err, accion);
    }
  }

  private validarEmail(email: string): void {
    if (!email || EMAIL_INVALIDO.test(email)) {
      throw new SignatureProviderError(
        `El correo "${email}" tiene caracteres que Signapis no acepta (tildes, ñ, &, %, comillas, etc.). Corrige el correo del paciente.`,
        400,
        { codigo: 'EMAIL' }
      );
    }
  }

  // ─── Firma ───────────────────────────────────────────────

  async requestSignature(params: RequestSignatureParams): Promise<SignatureInitResult> {
    this.validarEmail(params.signer.email);
    if (!params.certificateSerial) {
      throw new SignatureProviderError('El firmante no tiene certificado de firma.', 409, { codigo: 'REQUIERE_CERTIFICADO' });
    }
    if (params.document.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new SignatureProviderError('Solo se pueden firmar archivos PDF. Sube el documento en PDF.', 400, { codigo: 'PDF' });
    }
    if (params.document.length > MAX_PDF_BYTES) {
      throw new SignatureProviderError('El PDF supera los 5 MB que acepta Signapis. Sube una versión más liviana.', 400, {
        codigo: 'PDF',
      });
    }

    // 1. Subir el documento
    const subida = await this.llamar<{ documentId: string }>('POST', '/v2/documents', 'subir el documento', {
      name: nombrePdf(params.documentName),
      document: params.document.toString('base64'),
      signatories: [params.signer.email],
      metadata: {
        // Debe ser único en Signapis: un mismo documento puede enviarse a firma más de una vez.
        documentClientId: `${params.documentId}-${Date.now()}`,
        referencia: params.reference,
      },
    });
    const documentId = subida.data?.documentId;
    if (!documentId) throw new SignatureProviderError('Signapis no devolvió el ID del documento.', 502);

    // 2. Pedir la firma
    const { estampa } = params;
    const body: Json = {
      email: params.signer.email,
      documentId,
      certificateSerialNumber: params.certificateSerial,
      signatureType: estampa.tipoEstampa,
      viewDocument: true,
      withQR: estampa.conQR,
      redirectUrl: params.redirectUrl,
    };
    if (estampa.tipoEstampa === 2) body.signatureText = (estampa.textoEstampa || '').slice(0, 120);
    if (estampa.posicion) {
      body.positions = [
        { pageNumber: String(estampa.posicion.pagina), x: String(estampa.posicion.x), y: String(estampa.posicion.y) },
      ];
    }

    let firma: RespuestaSignapis<{ token: string; signUrl: string }>;
    try {
      firma = await this.llamar('POST', '/v2/requestSign', 'solicitar la firma', body);
    } catch (err) {
      // No dejar el documento huérfano en Signapis.
      await this.cancelSignature(documentId).catch(() => undefined);
      throw err;
    }

    return {
      success: true,
      signatureId: documentId,
      status: 'enviado',
      signingUrl: firma.data?.signUrl,
      message: 'Documento listo para firmar en Signapis.',
      raw: { trackingId: firma.trackingId, token: firma.data?.token },
    };
  }

  async getSignatureStatus(signatureId: string): Promise<SignatureStatusResult> {
    const resp = await this.llamar<Json>('GET', `/v2/documents/${encodeURIComponent(signatureId)}`, 'consultar el documento');
    const data = resp.data ?? {};
    const estadoProveedor = String(data.status ?? '').replace(/,$/, '').toUpperCase();
    const status = this.estadoDocumento(estadoProveedor);
    return {
      signatureId,
      status,
      signedDocumentUrl: status === 'firmado' ? str(data.document) : undefined,
      message: status === 'firmado' ? 'Documento firmado.' : `Estado en Signapis: ${estadoProveedor || 'desconocido'}`,
    };
  }

  private estadoDocumento(estado: string): SignatureStatus {
    if (estado === 'SIGNED' || estado === 'COMPLETE' || estado === 'COMPLETED') return 'firmado';
    if (estado === 'REJECTED' || estado === 'REJECT') return 'rechazado';
    if (estado.startsWith('CANCEL')) return 'cancelado';
    return 'enviado';
  }

  async cancelSignature(signatureId: string): Promise<{ success: boolean; message: string }> {
    await this.llamar('PATCH', `/v2/documents/${encodeURIComponent(signatureId)}/cancel`, 'cancelar el documento');
    return { success: true, message: 'Solicitud de firma cancelada en Signapis.' };
  }

  // ─── Certificados ────────────────────────────────────────

  async findActiveCertificate(email: string): Promise<string | null> {
    this.validarEmail(email);
    try {
      const resp = await this.llamar<Array<Json>>(
        'GET',
        `/v2/certificates/${encodeURIComponent(email)}`,
        'consultar certificados'
      );
      const activos = (resp.data ?? [])
        .filter((c) => c.status === 'ACTIVE' && !c.oneTimeSignature)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      return str(activos[0]?.serialNumber) ?? null;
    } catch (err) {
      // Usuario sin registro en Signapis = sin certificado.
      const msg = (err as SignatureProviderError).detalle?.mensajeProveedor ?? '';
      if (/no registered user|user not found|certificate not found/i.test(msg)) return null;
      throw err;
    }
  }

  async requestCertificate(params: CertificateRequestParams): Promise<CertificateRequestResult> {
    this.validarEmail(params.email);
    const resp = await this.llamar<{ token: string; validateUserUrl: string }>(
      'POST',
      '/v2/requestCertificate',
      'solicitar el certificado',
      {
        identification: params.rut,
        serialNumber: params.serialNumber,
        phoneNumber: params.phone,
        commune: params.comuna,
        email: params.email,
        certTime: params.years,
        notification: ['COMPLETED'],
        redirectUrl: params.redirectUrl,
      }
    );
    if (!resp.data?.token || !resp.data.validateUserUrl) {
      throw new SignatureProviderError('Signapis no entregó el enlace de enrolamiento.', 502);
    }
    return {
      token: resp.data.token,
      enrollUrl: resp.data.validateUserUrl,
      message: 'Certificado solicitado. El paciente debe validar su identidad en Signapis.',
    };
  }

  // ─── Webhook ─────────────────────────────────────────────

  async handleCallback(data: Record<string, unknown>): Promise<CallbackEvent> {
    const code = String(data.code ?? '').toUpperCase();
    const ok = String(data.status ?? '').toUpperCase() === 'SUCCESS';
    const doc = (data.document && typeof data.document === 'object' ? data.document : {}) as Json;
    const message = str(data.message) ?? code;

    // Documento firmado, completado, rechazado o cancelado
    if (['SIGN', 'COMPLETE', 'REJECT', 'CANCEL'].includes(code) && str(doc.documentId)) {
      const usuario = ((data.user as Json) ?? (Array.isArray(data.users) ? (data.users[0] as Json) : undefined) ?? {}) as Json;
      const download = (doc.download && typeof doc.download === 'object' ? doc.download : {}) as Json;
      let status: SignatureStatus = 'error';
      if (ok) status = code === 'REJECT' ? 'rechazado' : code === 'CANCEL' ? 'cancelado' : 'firmado';
      const observacion = str(data.observationReject) ?? str(usuario.observation);
      const textos: Record<string, string> = {
        firmado: 'Documento firmado con firma electrónica avanzada.',
        rechazado: `El firmante rechazó el documento${observacion ? `: ${observacion}` : '.'}`,
        cancelado: 'El documento fue cancelado en Signapis.',
        error: `Signapis informó un error: ${message}`,
      };
      return {
        tipo: 'firma',
        signatureId: str(doc.documentId)!,
        status,
        signedBy: str(usuario.fullName),
        signerRut: str(usuario.identification),
        signedAt: fecha(usuario.datetime) ?? fecha(data.datetime),
        signedDocumentUrl: str(download.url),
        message: textos[status],
      };
    }

    // Enrolamiento: certificado emitido
    if (code === 'CERTIFICATE_CREATED') {
      const usuario = (data.user ?? {}) as Json;
      return {
        tipo: 'certificado',
        estado: ok ? 'activo' : 'fallido',
        token: str(data.token),
        email: str(usuario.email),
        numeroSerie: str(data.certificate),
        message: ok ? 'Certificado de firma emitido.' : message,
      };
    }

    // Enrolamiento: pasos de validación de identidad
    if (PASOS_ENROLAMIENTO[code] && str(data.token)) {
      return {
        tipo: 'certificado',
        estado: 'en_curso',
        token: str(data.token),
        message: ok
          ? `Validación superada: ${PASOS_ENROLAMIENTO[code]}.`
          : `No se pudo validar: ${PASOS_ENROLAMIENTO[code]} (${message}).`,
      };
    }

    // Certificado suspendido, revocado o reactivado
    if (['SUSPENDED', 'REVOKED', 'REACTIVATED'].includes(code) && ok) {
      return {
        tipo: 'certificado',
        estado: code === 'REACTIVATED' ? 'activo' : 'fallido',
        email: str(data.email),
        numeroSerie: str(data.certificateSerialNumber),
        message:
          code === 'REACTIVATED'
            ? 'Certificado reactivado.'
            : `Certificado ${code === 'SUSPENDED' ? 'suspendido' : 'revocado'} por su titular.`,
      };
    }

    return { tipo: 'ignorado', message: `Notificación ${code || 'sin código'} sin acción.` };
  }

  // ─── Administración ──────────────────────────────────────

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    await this.obtenerToken(true);
    return { ok: true, message: `Conexión correcta con Signapis (${env.SIGNAPIS_AMBIENTE}).` };
  }

  async configureWebhook(url: string, secret: string): Promise<{ message: string }> {
    await this.llamar('POST', '/v2/company/webhook', 'configurar el webhook', {
      url,
      authType: 'WEBHOOK_API_KEY',
      // Signapis enviará estos headers en cada notificación.
      authValue: { 'X-Callback-Secret': secret, 'Content-Type': 'application/json' },
    });
    return { message: `Webhook registrado en Signapis: ${url}` };
  }

  async getWebhook(): Promise<{ url?: string; authType?: string } | null> {
    try {
      const resp = await this.llamar<Json>('GET', '/v2/company/webhook', 'consultar el webhook');
      if (!resp.data) return null;
      return { url: str(resp.data.url), authType: str(resp.data.authType) };
    } catch (err) {
      if ((err as SignatureProviderError).status === 400) return null;
      throw err;
    }
  }

  async testWebhook(): Promise<{ message: string }> {
    await this.llamar('POST', '/v2/company/webhook/test', 'probar el webhook', {
      code: 'TEST',
      message: 'Prueba de webhook desde Dispensapp',
    });
    return { message: 'Signapis envió una notificación de prueba al webhook.' };
  }
}
