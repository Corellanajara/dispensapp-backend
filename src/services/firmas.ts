import axios from 'axios';
import { Types } from 'mongoose';
import { Patient, IPatient, IDocument } from '../models/Patient';
import { DOCUMENT_TYPE_LABELS, DocumentType } from '../config/documentos';
import { comunaSignapis } from '../config/comunas';
import { env } from '../config/env';
import {
  getProvider,
  SignatureProviderError,
  type CallbackEvent,
  type ISignatureProvider,
  type SignatureInitResult,
  type SignatureStatusResult,
} from './signature';
import { configFirma, tipoRequiereFirma } from './configuracion';
import { readFileBuffer, saveBuffer } from './storage';
import { registrarAuditoria } from './audit';

/**
 * Firma electrónica de documentos del paciente.
 *
 * Qué se firma lo decide el administrador (Configuración → Firma electrónica):
 * interruptor general + tipos de documento. El proveedor se elige con SIGNATURE_PROVIDER.
 */

export type CodigoFirma =
  | 'DESHABILITADA'
  | 'NO_REQUIERE'
  | 'REQUIERE_CERTIFICADO'
  | 'CERTIFICADO_EN_CURSO'
  | 'SIN_PROVEEDOR'
  | 'COMUNA'
  | 'TELEFONO'
  | 'SERIE_CEDULA'
  | 'ARCHIVO'
  | 'ESTADO';

export class FirmaError extends Error {
  constructor(
    message: string,
    public status = 400,
    public codigo?: CodigoFirma | string
  ) {
    super(message);
  }
}

/** Convierte errores del proveedor en FirmaError para responder con un mensaje claro. */
export function comoFirmaError(err: unknown): FirmaError | null {
  if (err instanceof FirmaError) return err;
  if (err instanceof SignatureProviderError) {
    const tracking = err.detalle?.trackingId ? ` (seguimiento Signapis: ${err.detalle.trackingId})` : '';
    return new FirmaError(`${err.message}${tracking}`, err.status, err.detalle?.codigo);
  }
  return null;
}

// ─── Datos del firmante ────────────────────────────────────

/** RUT sin puntos y con guion: 12345678-9 */
export function formatearRut(rut: string): string {
  const limpio = rut.replace(/[^0-9kK]/g, '').toUpperCase();
  if (limpio.length < 2) return rut;
  return `${limpio.slice(0, -1)}-${limpio.slice(-1)}`;
}

/** Teléfono chileno con código de país y sin espacios (+56912345678), o null si no se reconoce. */
export function formatearTelefono(telefono?: string | null): string | null {
  if (!telefono) return null;
  const digitos = telefono.replace(/[^0-9+]/g, '');
  if (/^\+\d{8,15}$/.test(digitos)) return digitos;
  const solo = digitos.replace(/\D/g, '');
  if (/^56\d{9}$/.test(solo)) return `+${solo}`;
  if (/^9\d{8}$/.test(solo)) return `+56${solo}`;
  if (/^[2-8]\d{8}$/.test(solo)) return `+56${solo}`;
  return null;
}

/** Número de serie (número de documento) de la cédula, como lo exige Signapis. */
export function formatearSerieCedula(serie: string): string | null {
  const limpio = serie.replace(/\s/g, '');
  return /^(B|b|[0-9])[0-9A-Za-z]{2}[0-9.]{6,9}$/.test(limpio) ? limpio : null;
}

function firmante(patient: IPatient) {
  return {
    name: `${patient.nombre} ${patient.apellido}`.trim(),
    email: patient.email,
    rut: formatearRut(patient.rut),
  };
}

// ─── Proveedor y reglas ────────────────────────────────────

function proveedorActivo(): ISignatureProvider {
  const provider = getProvider();
  if (provider.name === 'mock' && env.NODE_ENV === 'production') {
    throw new FirmaError(
      'La firma electrónica no está conectada a un proveedor real (SIGNATURE_PROVIDER=mock).',
      503,
      'SIN_PROVEEDOR'
    );
  }
  const info = provider.info();
  if (!info.configurado) {
    throw new FirmaError(
      `La firma electrónica no está configurada. Faltan variables: ${info.faltantes.join(', ')}.`,
      503,
      'SIN_PROVEEDOR'
    );
  }
  return provider;
}

function exigirFirma(tipo: string): void {
  if (!configFirma().habilitada) {
    throw new FirmaError('La firma electrónica está desactivada por el administrador.', 400, 'DESHABILITADA');
  }
  if (!tipoRequiereFirma(tipo)) {
    throw new FirmaError('Este tipo de documento no se firma electrónicamente.', 400, 'NO_REQUIERE');
  }
}

// ─── Certificado del firmante ──────────────────────────────

export interface EstadoCertificado {
  /** El proveedor exige certificado propio del firmante. */
  requiere: boolean;
  estado: 'no_aplica' | 'activo' | 'enrolando' | 'falta' | 'fallido';
  mensaje?: string;
  enrolamientoUrl?: string;
  /** Datos que ya tenemos y si sirven para pedir el certificado. */
  datos: { comuna: string | null; telefono: string | null; email: string };
}

/**
 * Busca un certificado activo del paciente en el proveedor y lo deja registrado en la ficha.
 * @returns número de serie, o null si no tiene.
 */
async function certificadoVigente(patient: IPatient, provider: ISignatureProvider): Promise<string | null> {
  if (!provider.requiresCertificate || !provider.findActiveCertificate) return null;
  const serie = await provider.findActiveCertificate(patient.email);
  if (serie) {
    const actual = patient.certificadoFirma;
    if (actual?.estado !== 'activo' || actual.numeroSerie !== serie) {
      patient.certificadoFirma = {
        proveedor: provider.name,
        estado: 'activo',
        numeroSerie: serie,
        email: patient.email,
        mensaje: 'Certificado de firma activo.',
        fechaEmision: actual?.fechaEmision ?? new Date(),
      };
    }
  } else if (patient.certificadoFirma?.estado === 'activo') {
    patient.certificadoFirma.estado = 'fallido';
    patient.certificadoFirma.mensaje = 'El certificado ya no está activo en el proveedor.';
  }
  return serie;
}

/** Estado del certificado del paciente (consulta al proveedor). El llamador debe guardar el paciente. */
export async function consultarCertificado(patient: IPatient): Promise<EstadoCertificado> {
  const provider = proveedorActivo();
  const datos = {
    comuna: comunaSignapis(patient.direccion?.comuna),
    telefono: formatearTelefono(patient.telefono),
    email: patient.email,
  };
  if (!provider.requiresCertificate) return { requiere: false, estado: 'no_aplica', datos };

  const serie = await certificadoVigente(patient, provider);
  if (serie) return { requiere: true, estado: 'activo', datos, mensaje: patient.certificadoFirma?.mensaje };

  const c = patient.certificadoFirma;
  if (c?.estado === 'enrolando') {
    return { requiere: true, estado: 'enrolando', datos, mensaje: c.mensaje, enrolamientoUrl: c.enrolamientoUrl };
  }
  return { requiere: true, estado: c?.estado === 'fallido' ? 'fallido' : 'falta', datos, mensaje: c?.mensaje };
}

export interface DatosEnrolamiento {
  serieCedula: string;
  telefono?: string;
  comuna?: string;
}

/**
 * Pide al proveedor un certificado de firma para el paciente.
 * Devuelve la URL donde el paciente valida su identidad. El llamador debe guardar el paciente.
 */
export async function solicitarCertificado(
  patient: IPatient,
  datos: DatosEnrolamiento,
  redirectUrl: string
): Promise<{ enrollUrl: string; message: string }> {
  if (!configFirma().habilitada) {
    throw new FirmaError('La firma electrónica está desactivada por el administrador.', 400, 'DESHABILITADA');
  }
  const provider = proveedorActivo();
  if (!provider.requiresCertificate || !provider.requestCertificate) {
    throw new FirmaError('Este proveedor de firma no necesita certificado.', 400, 'NO_REQUIERE');
  }
  if (await certificadoVigente(patient, provider)) {
    throw new FirmaError('El paciente ya tiene un certificado de firma activo.', 409, 'ESTADO');
  }

  const serialNumber = formatearSerieCedula(datos.serieCedula);
  if (!serialNumber) {
    throw new FirmaError(
      'Número de documento de la cédula inválido. Es el número de serie impreso en la cédula (ej. 123.456.789).',
      400,
      'SERIE_CEDULA'
    );
  }
  const comuna = comunaSignapis(datos.comuna || patient.direccion?.comuna);
  if (!comuna) {
    throw new FirmaError('Selecciona la comuna de residencia del paciente de la lista.', 400, 'COMUNA');
  }
  const phone = formatearTelefono(datos.telefono || patient.telefono);
  if (!phone) {
    throw new FirmaError('Teléfono inválido. Usa formato +56912345678.', 400, 'TELEFONO');
  }

  const result = await provider.requestCertificate({
    rut: formatearRut(patient.rut),
    serialNumber,
    phone,
    comuna,
    email: patient.email,
    years: configFirma().vigenciaCertificadoAnios,
    redirectUrl,
  });

  patient.certificadoFirma = {
    proveedor: provider.name,
    estado: 'enrolando',
    token: result.token,
    email: patient.email,
    enrolamientoUrl: result.enrollUrl,
    mensaje: 'Esperando que el paciente valide su identidad en Signapis.',
    fechaSolicitud: new Date(),
  };
  return { enrollUrl: result.enrollUrl, message: result.message };
}

// ─── Firma de documentos ───────────────────────────────────

/**
 * Envía a firma un documento del paciente. Si ya hay una firma en curso devuelve el mismo enlace,
 * salvo que se pida reiniciar (cancela la anterior y crea una nueva).
 * El llamador debe guardar el paciente.
 */
export async function solicitarFirmaDocumento(
  patient: IPatient,
  doc: IDocument,
  solicitadoPor: Types.ObjectId,
  opts: { redirectUrl: string; reiniciar?: boolean }
): Promise<SignatureInitResult> {
  exigirFirma(doc.tipo);
  if (doc.estado === 'rechazado') {
    throw new FirmaError('El documento fue rechazado. Sube una nueva versión antes de firmar.', 400, 'ESTADO');
  }
  if (doc.firma?.estado === 'firmado') {
    throw new FirmaError('El documento ya está firmado.', 409, 'ESTADO');
  }

  const provider = proveedorActivo();

  if (doc.firma?.estado === 'enviado') {
    if (!opts.reiniciar && doc.firma.provider === provider.name) {
      return {
        success: true,
        signatureId: doc.firma.signatureId,
        status: 'enviado',
        signingUrl: doc.firma.signingUrl,
        message: 'La firma ya está en curso.',
      };
    }
    // Reiniciar: cancelar la anterior (si falla, igual se crea una nueva).
    await getProvider(doc.firma.provider)
      .cancelSignature(doc.firma.signatureId)
      .catch((err) => console.warn('[firma] No se pudo cancelar la firma anterior:', err?.message));
  }

  let certificateSerial: string | undefined;
  if (provider.requiresCertificate) {
    certificateSerial = (await certificadoVigente(patient, provider)) ?? undefined;
    if (!certificateSerial) {
      const enCurso = patient.certificadoFirma?.estado === 'enrolando';
      throw new FirmaError(
        enCurso
          ? 'El paciente aún no termina de obtener su certificado de firma en Signapis.'
          : 'El paciente necesita un certificado de firma electrónica avanzada antes de firmar.',
        409,
        enCurso ? 'CERTIFICADO_EN_CURSO' : 'REQUIERE_CERTIFICADO'
      );
    }
  }

  const archivo = await readFileBuffer(doc.archivo);
  if (!archivo) {
    throw new FirmaError('No se encontró el archivo del documento. Súbelo de nuevo.', 404, 'ARCHIVO');
  }

  const cfg = configFirma();
  const etiqueta = DOCUMENT_TYPE_LABELS[doc.tipo as DocumentType] ?? doc.tipo;
  const result = await provider.requestSignature({
    documentId: doc._id.toString(),
    documentName: `${etiqueta} ${formatearRut(patient.rut)}`,
    document: archivo,
    signer: firmante(patient),
    certificateSerial,
    reference: `${formatearRut(patient.rut)} - ${etiqueta}`,
    redirectUrl: opts.redirectUrl,
    estampa: {
      tipoEstampa: cfg.tipoEstampa,
      textoEstampa: cfg.textoEstampa,
      conQR: cfg.conQR,
      posicion: cfg.posicion,
    },
  });

  doc.firma = {
    signatureId: result.signatureId,
    provider: provider.name,
    estado: result.status,
    signingUrl: result.signingUrl,
    solicitadoPor,
    fechaSolicitud: new Date(),
    mensaje: result.message,
    fechaActualizacion: new Date(),
  };
  // Los datos crudos del proveedor no se devuelven al navegador.
  const { raw: _raw, ...publico } = result;
  return publico;
}

/** Cancela una firma en curso. El llamador debe guardar el paciente. */
export async function cancelarFirma(doc: IDocument): Promise<void> {
  if (!doc.firma || doc.firma.estado !== 'enviado') {
    throw new FirmaError('No hay una firma en curso para cancelar.', 400, 'ESTADO');
  }
  await getProvider(doc.firma.provider).cancelSignature(doc.firma.signatureId);
  doc.firma.estado = 'cancelado';
  doc.firma.mensaje = 'Firma cancelada por el dispensario.';
  doc.firma.fechaActualizacion = new Date();
}

/** Descarga el PDF firmado desde el enlace temporal del proveedor y lo guarda en nuestro almacenamiento. */
async function guardarPdfFirmado(url: string, doc: IDocument): Promise<string> {
  const resp = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 30 * 1024 * 1024 });
  const buffer = Buffer.from(resp.data);
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('El archivo firmado descargado no es un PDF.');
  }
  return saveBuffer(buffer, `firmado-${doc._id.toString()}.pdf`, 'application/pdf', { privado: true });
}

/**
 * Aplica al documento el estado que informó el proveedor (webhook o consulta).
 * Nunca retrocede una firma ya completada.
 * @returns true si cambió algo (el llamador debe guardar el paciente).
 */
export async function aplicarResultadoFirma(
  doc: IDocument,
  result: SignatureStatusResult,
  opts: { fallarSiNoDescarga?: boolean } = {}
): Promise<boolean> {
  const firma = doc.firma;
  if (!firma) return false;
  if (firma.estado === 'firmado' && firma.archivoFirmado) return false;

  let cambio = false;
  if (result.status !== firma.estado && !(firma.estado === 'firmado' && result.status !== 'firmado')) {
    firma.estado = result.status;
    cambio = true;
  }
  if (result.message && result.message !== firma.mensaje) {
    firma.mensaje = result.message;
    cambio = true;
  }

  if (firma.estado === 'firmado') {
    firma.firmadoPor = result.signedBy ?? firma.firmadoPor;
    firma.rutFirmante = result.signerRut ?? firma.rutFirmante;
    firma.fechaFirma = result.signedAt ?? firma.fechaFirma ?? new Date();
    if (!firma.archivoFirmado) {
      if (result.signedDocumentUrl?.startsWith('http')) {
        try {
          firma.archivoFirmado = await guardarPdfFirmado(result.signedDocumentUrl, doc);
        } catch (err) {
          // En el webhook se relanza: responde 500 y el proveedor reintenta.
          if (opts.fallarSiNoDescarga) throw err;
          console.error('[firma] No se pudo descargar el PDF firmado:', (err as Error).message);
          firma.mensaje = 'Firmado. El PDF firmado aún no se pudo descargar; actualiza el estado más tarde.';
        }
      } else if (firma.provider === 'mock') {
        firma.archivoFirmado = doc.archivo;
      }
    }
    cambio = true;
  }

  if (cambio) firma.fechaActualizacion = new Date();
  return cambio;
}

/**
 * Consulta al proveedor el estado de una firma en curso (respaldo si no llegó el webhook).
 * @returns true si cambió (el llamador debe guardar el paciente).
 */
export async function actualizarEstadoFirma(doc: IDocument): Promise<boolean> {
  const firma = doc.firma;
  if (!firma) return false;
  const pendienteArchivo = firma.estado === 'firmado' && !firma.archivoFirmado;
  if (firma.estado !== 'enviado' && !pendienteArchivo) return false;

  const status = await getProvider(firma.provider).getSignatureStatus(firma.signatureId);
  return aplicarResultadoFirma(doc, status);
}

// ─── Notificaciones del proveedor ──────────────────────────

/** Procesa una notificación ya normalizada. Devuelve un resumen para el log. */
export async function procesarNotificacion(evento: CallbackEvent): Promise<string> {
  if (evento.tipo === 'ignorado') return evento.message;

  if (evento.tipo === 'firma') {
    const patient = await Patient.findOne({ 'documentos.firma.signatureId': evento.signatureId });
    const doc = patient?.documentos.find((d) => d.firma?.signatureId === evento.signatureId);
    if (!patient || !doc) return `Firma ${evento.signatureId} no corresponde a ningún documento.`;

    if (await aplicarResultadoFirma(doc, evento, { fallarSiNoDescarga: true })) {
      await patient.save();
      void registrarAuditoria({
        accion: `firma_${doc.firma!.estado}`,
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: {
          documento: doc._id,
          tipo: doc.tipo,
          proveedor: doc.firma!.provider,
          signatureId: evento.signatureId,
          firmante: evento.signerRut,
        },
      });
    }
    return `Documento ${doc._id}: firma ${doc.firma!.estado}.`;
  }

  // Certificado del paciente
  const filtros: Record<string, unknown>[] = [];
  if (evento.token) filtros.push({ 'certificadoFirma.token': evento.token });
  if (evento.numeroSerie) filtros.push({ 'certificadoFirma.numeroSerie': evento.numeroSerie });
  if (evento.email && evento.estado === 'activo') {
    filtros.push({ email: evento.email.toLowerCase(), 'certificadoFirma.estado': 'enrolando' });
  }
  if (!filtros.length) return 'Notificación de certificado sin datos para identificar al paciente.';

  const patient = await Patient.findOne({ $or: filtros });
  if (!patient?.certificadoFirma) return 'Notificación de certificado sin paciente asociado.';

  const c = patient.certificadoFirma;
  c.mensaje = evento.message;
  if (evento.estado === 'activo') {
    c.estado = 'activo';
    c.numeroSerie = evento.numeroSerie ?? c.numeroSerie;
    c.fechaEmision = new Date();
    c.enrolamientoUrl = undefined;
  } else if (evento.estado === 'fallido') {
    c.estado = 'fallido';
  }
  patient.markModified('certificadoFirma');
  await patient.save();

  if (evento.estado !== 'en_curso') {
    void registrarAuditoria({
      accion: evento.estado === 'activo' ? 'certificado_firma_emitido' : 'certificado_firma_inactivo',
      entidad: 'paciente',
      entidadId: patient._id as Types.ObjectId,
      sucursal: patient.sucursal,
      detalles: { numeroSerie: c.numeroSerie, mensaje: evento.message },
    });
  }
  return `Certificado del paciente ${patient._id}: ${c.estado} (${evento.message}).`;
}

// ─── Respuestas HTTP ───────────────────────────────────────

/** Responde un error de firma con mensaje y código legibles por el frontend. */
export function responderErrorFirma(
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  error: unknown,
  mensajeGenerico: string
): void {
  const fe = comoFirmaError(error);
  if (fe) {
    res.status(fe.status).json({ message: fe.message, codigo: fe.codigo });
    return;
  }
  console.error(`${mensajeGenerico}:`, error);
  res.status(500).json({ message: mensajeGenerico });
}

/** URLs del frontend a las que vuelve el firmante al terminar en el proveedor. */
export const retornoFirma = {
  personal: () => `${env.FRONTEND_URL}/firma/completada`,
  personalCertificado: () => `${env.FRONTEND_URL}/firma/completada?paso=certificado`,
  paciente: () => `${env.FRONTEND_URL}/portal/perfil?firma=listo`,
  pacienteCertificado: () => `${env.FRONTEND_URL}/portal/perfil?certificado=listo`,
};
