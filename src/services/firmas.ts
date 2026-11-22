import axios from 'axios';
import { Types } from 'mongoose';
import { Patient, IPatient, IDocument } from '../models/Patient';
import { FirmaDemo } from '../models/FirmaDemo';
import { User, IUser } from '../models/User';
import type { IDocumentSignature, ISignerCertificate } from '../models/shared';
import { DOCUMENT_TYPE_LABELS, DocumentType, esTipoGenerado } from '../config/documentos';
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
import { configFirma, tipoRequiereFirma, tipoRequiereContrafirma } from './configuracion';
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
  | 'ESTADO'
  | 'NO_RESPONSABLE';

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

/** Quien firma: un paciente o la firma de prueba del administrador. */
export interface TitularFirma {
  rut: string;
  email: string;
  telefono?: string;
  direccion?: { comuna?: string };
  certificadoFirma?: ISignerCertificate;
}

/** Documento que se envía a firmar: del paciente o de la firma de prueba. */
export interface DocFirmable {
  _id: Types.ObjectId;
  archivo: string;
  firma?: IDocumentSignature;
  contrafirma?: IDocumentSignature;
}

/** Cuál de las firmas del documento: la del paciente o la del responsable del dispensario. */
export type CampoFirma = 'firma' | 'contrafirma';

export function proveedorActivo(): ISignatureProvider {
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
export async function certificadoVigente(patient: TitularFirma, provider: ISignatureProvider): Promise<string | null> {
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

/** Estado del certificado del firmante (consulta al proveedor). El llamador debe guardar al titular. */
export async function consultarCertificado(patient: TitularFirma): Promise<EstadoCertificado> {
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
  patient: TitularFirma,
  datos: DatosEnrolamiento,
  redirectUrl: string,
  opts: { esPrueba?: boolean } = {}
): Promise<{ enrollUrl: string; message: string }> {
  // La firma de prueba funciona aunque el administrador haya apagado la firma.
  if (!opts.esPrueba && !configFirma().habilitada) {
    throw new FirmaError('La firma electrónica está desactivada por el administrador.', 400, 'DESHABILITADA');
  }
  const provider = proveedorActivo();
  if (!provider.requiresCertificate || !provider.requestCertificate) {
    throw new FirmaError('Este proveedor de firma no necesita certificado.', 400, 'NO_REQUIERE');
  }
  if (await certificadoVigente(patient, provider)) {
    throw new FirmaError(
      opts.esPrueba ? 'Ese correo ya tiene un certificado de firma activo.' : 'El paciente ya tiene un certificado de firma activo.',
      409,
      'ESTADO'
    );
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
    throw new FirmaError('Selecciona la comuna de residencia de la lista.', 400, 'COMUNA');
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
    mensaje: opts.esPrueba
      ? 'Esperando la validación de identidad en Signapis.'
      : 'Esperando que el paciente valide su identidad en Signapis.',
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
    throw new FirmaError(
      esTipoGenerado(doc.tipo)
        ? 'El documento fue rechazado. Genera una nueva versión antes de firmar.'
        : 'El documento fue rechazado. Sube una nueva versión antes de firmar.',
      400,
      'ESTADO'
    );
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
      // Los documentos que genera la plataforma traen su propio espacio de firma.
      posicion: posicionDe(doc) ?? cfg.posicion,
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
export async function cancelarFirma(doc: DocFirmable, campo: CampoFirma = 'firma'): Promise<void> {
  const firma = doc[campo];
  if (!firma || firma.estado !== 'enviado') {
    throw new FirmaError('No hay una firma en curso para cancelar.', 400, 'ESTADO');
  }
  await getProvider(firma.provider).cancelSignature(firma.signatureId);
  firma.estado = 'cancelado';
  firma.mensaje = 'Firma cancelada por el dispensario.';
  firma.fechaActualizacion = new Date();
}

/** Descarga el PDF firmado desde el enlace temporal del proveedor y lo guarda en nuestro almacenamiento. */
async function guardarPdfFirmado(url: string, doc: DocFirmable, campo: CampoFirma): Promise<string> {
  const resp = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: 30 * 1024 * 1024 });
  const buffer = Buffer.from(resp.data);
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('El archivo firmado descargado no es un PDF.');
  }
  const prefijo = campo === 'contrafirma' ? 'contrafirmado' : 'firmado';
  return saveBuffer(buffer, `${prefijo}-${doc._id.toString()}.pdf`, 'application/pdf', { privado: true });
}

/**
 * Aplica al documento el estado que informó el proveedor (webhook o consulta).
 * Nunca retrocede una firma ya completada.
 * @returns true si cambió algo (el llamador debe guardar el paciente).
 */
export async function aplicarResultadoFirma(
  doc: DocFirmable,
  result: SignatureStatusResult,
  opts: { fallarSiNoDescarga?: boolean; campo?: CampoFirma } = {}
): Promise<boolean> {
  const campo = opts.campo ?? 'firma';
  const firma = doc[campo];
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
          firma.archivoFirmado = await guardarPdfFirmado(result.signedDocumentUrl, doc, campo);
        } catch (err) {
          // En el webhook se relanza: responde 500 y el proveedor reintenta.
          if (opts.fallarSiNoDescarga) throw err;
          console.error('[firma] No se pudo descargar el PDF firmado:', (err as Error).message);
          firma.mensaje = 'Firmado. El PDF firmado aún no se pudo descargar; actualiza el estado más tarde.';
        }
      } else if (firma.provider === 'mock') {
        firma.archivoFirmado = campo === 'contrafirma' ? doc.firma?.archivoFirmado ?? doc.archivo : doc.archivo;
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
export async function actualizarEstadoFirma(doc: DocFirmable, campo: CampoFirma = 'firma'): Promise<boolean> {
  const firma = doc[campo];
  if (!firma) return false;
  const pendienteArchivo = firma.estado === 'firmado' && !firma.archivoFirmado;
  if (firma.estado !== 'enviado' && !pendienteArchivo) return false;

  const status = await getProvider(firma.provider).getSignatureStatus(firma.signatureId);
  return aplicarResultadoFirma(doc, status, { campo });
}

// ─── Notificaciones del proveedor ──────────────────────────

function aplicarEventoCertificado(
  c: ISignerCertificate,
  evento: Extract<CallbackEvent, { tipo: 'certificado' }>
): void {
  c.mensaje = evento.message;
  if (evento.estado === 'activo') {
    c.estado = 'activo';
    c.numeroSerie = evento.numeroSerie ?? c.numeroSerie;
    c.fechaEmision = new Date();
    c.enrolamientoUrl = undefined;
  } else if (evento.estado === 'fallido') {
    c.estado = 'fallido';
  }
}

/** Procesa una notificación ya normalizada. Devuelve un resumen para el log. */
export async function procesarNotificacion(evento: CallbackEvent): Promise<string> {
  if (evento.tipo === 'ignorado') return evento.message;

  if (evento.tipo === 'firma') {
    const contra = await Patient.findOne({ 'documentos.contrafirma.signatureId': evento.signatureId });
    const docContra = contra?.documentos.find((d) => d.contrafirma?.signatureId === evento.signatureId);
    if (contra && docContra) {
      if (await aplicarResultadoFirma(docContra, evento, { fallarSiNoDescarga: true, campo: 'contrafirma' })) {
        cerrarValidacion(docContra);
        await contra.save();
        auditarContrafirma(contra, docContra, evento.signerRut);
      }
      return `Documento ${docContra._id}: contrafirma ${docContra.contrafirma!.estado}.`;
    }

    const patient = await Patient.findOne({ 'documentos.firma.signatureId': evento.signatureId });
    const doc = patient?.documentos.find((d) => d.firma?.signatureId === evento.signatureId);
    if (!patient || !doc) {
      const demo = await FirmaDemo.findOne({ 'firma.signatureId': evento.signatureId });
      if (!demo) return `Firma ${evento.signatureId} no corresponde a ningún documento.`;
      if (await aplicarResultadoFirma(demo, evento, { fallarSiNoDescarga: true })) {
        demo.markModified('firma');
        await demo.save();
      }
      return `Firma de prueba ${demo._id}: ${demo.firma!.estado}.`;
    }

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
  if (!patient?.certificadoFirma) {
    const responsable = await User.findOne({ $or: filtros });
    if (responsable?.certificadoFirma) {
      aplicarEventoCertificado(responsable.certificadoFirma, evento);
      responsable.markModified('certificadoFirma');
      await responsable.save();
      return `Certificado del responsable ${responsable._id}: ${responsable.certificadoFirma.estado}.`;
    }
    const demo = await FirmaDemo.findOne({ $or: filtros });
    if (!demo?.certificadoFirma) return 'Notificación de certificado sin paciente asociado.';
    aplicarEventoCertificado(demo.certificadoFirma, evento);
    demo.markModified('certificadoFirma');
    await demo.save();
    return `Certificado de la firma de prueba ${demo._id}: ${demo.certificadoFirma.estado}.`;
  }

  const c = patient.certificadoFirma;
  aplicarEventoCertificado(c, evento);
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

// ─── Validación del dispensario (contrafirma) ──────────────

/**
 * Etapa de un documento que se firma, mirando ambas firmas.
 * - firma_paciente: falta la firma del paciente (o está en curso).
 * - por_validar: el paciente firmó; espera que un responsable lo revise y contrafirme.
 * - contrafirma_en_curso: el responsable abrió la contrafirma en Signapis y aún no termina.
 * - completo: firmado por ambos (o por el paciente, si la contrafirma está apagada).
 * - rechazado: el responsable lo rechazó; el paciente debe subir una nueva versión.
 */
export type EtapaValidacion = 'no_aplica' | 'firma_paciente' | 'por_validar' | 'contrafirma_en_curso' | 'completo' | 'rechazado';

export function etapaValidacion(doc: Pick<IDocument, 'tipo' | 'estado' | 'firma' | 'contrafirma'>): EtapaValidacion {
  if (!tipoRequiereFirma(doc.tipo)) return 'no_aplica';
  if (doc.estado === 'rechazado') return 'rechazado';
  if (doc.firma?.estado !== 'firmado') return 'firma_paciente';
  if (!tipoRequiereContrafirma(doc.tipo)) return 'completo';
  if (doc.contrafirma?.estado === 'firmado') return 'completo';
  if (doc.contrafirma?.estado === 'enviado') return 'contrafirma_en_curso';
  return 'por_validar';
}

/** true si el documento ya tiene todas las firmas que exige la configuración actual. */
export function firmasCompletas(doc: Pick<IDocument, 'tipo' | 'estado' | 'firma' | 'contrafirma'>): boolean {
  const etapa = etapaValidacion(doc);
  return etapa === 'completo' || etapa === 'no_aplica';
}

/** Al quedar contrafirmado, el documento queda aprobado por el responsable que lo firmó. */
function cerrarValidacion(doc: IDocument): void {
  const c = doc.contrafirma;
  if (c?.estado !== 'firmado' || doc.estado === 'rechazado') return;
  if (doc.estado !== 'aprobado') {
    doc.estado = 'aprobado';
    doc.revisadoPor = c.solicitadoPor as Types.ObjectId | undefined;
    doc.fechaRevision = c.fechaFirma ?? new Date();
  }
}

function auditarContrafirma(patient: IPatient, doc: IDocument, rutFirmante?: string): void {
  void registrarAuditoria({
    usuario: doc.contrafirma?.solicitadoPor as Types.ObjectId | undefined,
    accion: `contrafirma_${doc.contrafirma!.estado}`,
    entidad: 'paciente',
    entidadId: patient._id as Types.ObjectId,
    sucursal: patient.sucursal,
    detalles: { documento: doc._id, tipo: doc.tipo, signatureId: doc.contrafirma!.signatureId, firmante: rutFirmante },
  });
}

/** Exige que el usuario sea responsable de firma (admin u operador marcado por el administrador). */
export function exigirResponsable(user: IUser): void {
  if (!user.responsableFirma || !['admin', 'operador'].includes(user.role)) {
    throw new FirmaError(
      'Solo un responsable de firma del dispensario puede validar documentos. Pídele al administrador que te marque como responsable en Usuarios.',
      403,
      'NO_RESPONSABLE'
    );
  }
}

/**
 * El responsable contrafirma el PDF que ya firmó el paciente.
 * Devuelve el enlace de Signapis donde firma. El llamador debe guardar el paciente (y al usuario si cambió su certificado).
 */
export async function solicitarContrafirma(
  patient: IPatient,
  doc: IDocument,
  responsable: IUser,
  opts: { redirectUrl: string; reiniciar?: boolean }
): Promise<SignatureInitResult> {
  exigirResponsable(responsable);
  exigirFirma(doc.tipo);
  if (!tipoRequiereContrafirma(doc.tipo)) {
    throw new FirmaError('La validación del dispensario está desactivada para este documento.', 400, 'NO_REQUIERE');
  }
  const etapa = etapaValidacion(doc);
  if (etapa === 'rechazado') throw new FirmaError('El documento fue rechazado: el paciente debe subir una nueva versión.', 400, 'ESTADO');
  if (etapa === 'firma_paciente') throw new FirmaError('El paciente aún no firma este documento.', 409, 'ESTADO');
  if (etapa === 'completo') throw new FirmaError('El documento ya está validado y contrafirmado.', 409, 'ESTADO');

  const provider = proveedorActivo();
  const actual = doc.contrafirma;
  if (actual?.estado === 'enviado') {
    const mismoResponsable = String(actual.solicitadoPor) === String(responsable._id);
    if (!opts.reiniciar && mismoResponsable && actual.provider === provider.name && actual.signingUrl) {
      return {
        success: true,
        signatureId: actual.signatureId,
        status: 'enviado',
        signingUrl: actual.signingUrl,
        message: 'La contrafirma ya está en curso.',
      };
    }
    // Otro responsable la toma, o se pidió un enlace nuevo: se cancela la anterior.
    await getProvider(actual.provider)
      .cancelSignature(actual.signatureId)
      .catch((err) => console.warn('[contrafirma] No se pudo cancelar la anterior:', err?.message));
  }

  let certificateSerial: string | undefined;
  if (provider.requiresCertificate) {
    certificateSerial = (await certificadoVigente(responsable, provider)) ?? undefined;
    if (!certificateSerial) {
      const enCurso = responsable.certificadoFirma?.estado === 'enrolando';
      throw new FirmaError(
        enCurso
          ? 'Aún no terminas de obtener tu certificado de firma en Signapis.'
          : 'Necesitas tu certificado de firma electrónica avanzada antes de contrafirmar.',
        409,
        enCurso ? 'CERTIFICADO_EN_CURSO' : 'REQUIERE_CERTIFICADO'
      );
    }
  }

  // Se contrafirma el PDF que firmó el paciente, para que el archivo final lleve ambas firmas.
  const origen = doc.firma?.archivoFirmado;
  const archivo = origen ? await readFileBuffer(origen) : null;
  if (!archivo) {
    throw new FirmaError(
      'Aún no tenemos el PDF firmado por el paciente. Actualiza el estado de su firma e inténtalo de nuevo.',
      409,
      'ARCHIVO'
    );
  }

  const cfg = configFirma();
  const etiqueta = DOCUMENT_TYPE_LABELS[doc.tipo as DocumentType] ?? doc.tipo;
  const posicion = posicionDe(doc) ?? cfg.posicion ?? { pagina: 1, x: 100, y: 650 };
  const result = await provider.requestSignature({
    documentId: `${doc._id.toString()}-contrafirma`,
    documentName: `${etiqueta} ${formatearRut(patient.rut)} validado`,
    document: archivo,
    signer: {
      name: `${responsable.nombre} ${responsable.apellido}`.trim(),
      email: responsable.email,
      rut: formatearRut(responsable.rut),
    },
    certificateSerial,
    reference: `${formatearRut(patient.rut)} - ${etiqueta} - validación del dispensario`,
    redirectUrl: opts.redirectUrl,
    estampa: {
      tipoEstampa: cfg.tipoEstampa,
      textoEstampa: cfg.textoEstampa,
      conQR: cfg.conQR,
      posicion: posicionContrafirma(posicion),
    },
  });

  doc.contrafirma = {
    signatureId: result.signatureId,
    provider: provider.name,
    estado: result.status,
    signingUrl: result.signingUrl,
    solicitadoPor: responsable._id,
    fechaSolicitud: new Date(),
    mensaje: result.message,
    fechaActualizacion: new Date(),
  };
  const { raw: _raw, ...publico } = result;
  return publico;
}

/** Posición de firma guardada en el documento (los que genera la plataforma). */
function posicionDe(doc: IDocument): { pagina: number; x: number; y: number } | null {
  const p = doc.posicionFirma;
  return p && p.pagina && p.x != null && p.y != null ? { pagina: p.pagina, x: p.x, y: p.y } : null;
}

/**
 * Dónde va la estampa del responsable: al lado de la del paciente (el campo de firma de Signapis
 * mide cerca de un tercio del ancho de una hoja carta, 612 px), para que no se tapen.
 */
function posicionContrafirma(p: { pagina: number; x: number; y: number }) {
  const ANCHO = 220;
  if (p.x + 2 * ANCHO <= 612) return { ...p, x: p.x + ANCHO };
  if (p.x - ANCHO >= 0) return { ...p, x: p.x - ANCHO };
  return { ...p, y: p.y > 400 ? p.y - 130 : p.y + 130 };
}

/** Consulta la contrafirma en el proveedor (respaldo del webhook). El llamador debe guardar el paciente. */
export async function actualizarContrafirma(patient: IPatient, doc: IDocument): Promise<boolean> {
  const cambio = await actualizarEstadoFirma(doc, 'contrafirma');
  if (cambio) {
    cerrarValidacion(doc);
    auditarContrafirma(patient, doc);
  }
  return cambio;
}

/**
 * El responsable rechaza lo firmado: el documento queda rechazado con el motivo y el paciente
 * debe subir una nueva versión y firmarla otra vez. El llamador debe guardar el paciente.
 */
export async function rechazarValidacion(doc: IDocument, responsable: IUser, motivo: string): Promise<void> {
  if (!responsable.responsableFirma && responsable.role !== 'admin') exigirResponsable(responsable);
  const etapa = etapaValidacion(doc);
  if (etapa === 'completo') throw new FirmaError('El documento ya está validado; no se puede rechazar.', 409, 'ESTADO');
  if (etapa === 'rechazado') throw new FirmaError('El documento ya está rechazado.', 409, 'ESTADO');
  if (doc.contrafirma?.estado === 'enviado') {
    await cancelarFirma(doc, 'contrafirma').catch((err) =>
      console.warn('[contrafirma] No se pudo cancelar al rechazar:', (err as Error).message)
    );
  }
  doc.estado = 'rechazado';
  doc.observaciones = motivo.trim();
  doc.revisadoPor = responsable._id as Types.ObjectId;
  doc.fechaRevision = new Date();
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
  prueba: () => `${env.FRONTEND_URL}/configuracion/firma?prueba=listo`,
  contrafirma: () => `${env.FRONTEND_URL}/validacion-firmas?firma=listo`,
  responsableCertificado: () => `${env.FRONTEND_URL}/validacion-firmas?certificado=listo`,
  pacienteCertificado: () => `${env.FRONTEND_URL}/portal/perfil?certificado=listo`,
};
