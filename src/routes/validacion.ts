import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import mongoose, { Types } from 'mongoose';
import { Patient, IPatient, IDocument } from '../models/Patient';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { resolveSucursal, getSucursalFilter, canAccessSucursal } from '../middleware/sucursal';
import { getDownloadUrl } from '../services/storage';
import { registrarAuditoria } from '../services/audit';
import { configFirma, tipoRequiereFirma, documentosRequeridos, requisitoPara } from '../services/configuracion';
import { DOCUMENT_TYPE_LABELS, DocumentType, REQUIRED_DOCUMENTS } from '../config/documentos';
import { reactivarSiCorresponde, inicioDelDia } from '../services/vigencia';
import { leerPrescripcion, PrescripcionError } from '../services/prescripcion';
import { calcularEtapa } from '../services/etapas';
import {
  etapaValidacion,
  EtapaValidacion,
  consultarCertificado,
  solicitarCertificado,
  solicitarContrafirma,
  actualizarContrafirma,
  actualizarEstadoFirma,
  rechazarValidacion,
  exigirResponsable,
  responderErrorFirma,
  retornoFirma,
} from '../services/firmas';

/**
 * Validación del dispensario: lo que firma el paciente queda en esta bandeja hasta que un
 * responsable de firma lo revise y lo contrafirme con su propio certificado, o lo rechace
 * (el paciente genera o sube una nueva versión y vuelve a firmar). Se repite hasta que cumple.
 *
 * También llegan aquí los documentos que el paciente sube y el dispensario solo revisa
 * (hoy el certificado de antecedentes): se aprueban o se rechazan, sin firma.
 */
const router = Router();

/** "por_revisar": documento sin firma que el dispensario aprueba o rechaza. */
type EtapaBandeja = EtapaValidacion | 'por_revisar';

const ETAPAS_PENDIENTES: EtapaBandeja[] = ['por_validar', 'contrafirma_en_curso', 'por_revisar'];

/** Tipos sin firma que se revisan en la bandeja. */
const TIPOS_REVISION = REQUIRED_DOCUMENTS.filter((r) => r.revisionEnBandeja).map((r) => r.tipo as string);

function etapaBandeja(doc: IDocument): EtapaBandeja {
  if (TIPOS_REVISION.includes(doc.tipo) && !tipoRequiereFirma(doc.tipo)) {
    if (doc.estado === 'pendiente') return 'por_revisar';
    return doc.estado === 'aprobado' ? 'completo' : 'rechazado';
  }
  return etapaValidacion(doc);
}

type EstadoRequisito = 'falta' | 'por_firmar' | 'firmando' | 'por_validar' | 'por_revisar' | 'rechazado' | 'listo';

/** Cómo va cada documento exigido del paciente (para ver el expediente completo en la bandeja). */
function progresoPaciente(patient: IPatient): { tipo: string; etiqueta: string; estado: EstadoRequisito }[] {
  const ultimos = new Map(ultimosPorTipo(patient).map((d) => [d.tipo as string, d]));
  return documentosRequeridos().map((req) => {
    const d = ultimos.get(req.tipo);
    let estado: EstadoRequisito;
    if (!d) estado = req.generadoPorPlataforma && req.requiereFirma ? 'por_firmar' : 'falta';
    else if (d.estado === 'rechazado') estado = 'rechazado';
    else if (req.requiereFirma) {
      const etapa = etapaValidacion(d);
      estado =
        etapa === 'completo'
          ? 'listo'
          : etapa === 'firma_paciente'
            ? d.firma?.estado === 'enviado'
              ? 'firmando'
              : 'por_firmar'
            : 'por_validar';
    } else estado = d.estado === 'aprobado' ? 'listo' : 'por_revisar';
    return { tipo: req.tipo, etiqueta: req.label, estado };
  });
}

function validar(req: AuthRequest, res: Response): boolean {
  const errors = validationResult(req);
  if (errors.isEmpty()) return true;
  res.status(400).json({ message: errors.array()[0].msg, errors: errors.array() });
  return false;
}

function baseUrl(req: AuthRequest): string {
  return `${req.protocol}://${req.get('host')}`;
}

/** Último documento de cada tipo: las versiones antiguas no se validan. */
function ultimosPorTipo(patient: IPatient): IDocument[] {
  const porTipo = new Map<string, IDocument>();
  for (const d of patient.documentos) {
    const actual = porTipo.get(d.tipo);
    if (!actual || new Date(d.fechaSubida).getTime() >= new Date(actual.fechaSubida).getTime()) porTipo.set(d.tipo, d);
  }
  return [...porTipo.values()];
}

function nombreDe(ref: unknown): string | undefined {
  if (ref && typeof ref === 'object' && 'nombre' in ref) {
    const u = ref as { nombre?: string; apellido?: string };
    return `${u.nombre ?? ''} ${u.apellido ?? ''}`.trim() || undefined;
  }
  return undefined;
}

function itemBandeja(patient: IPatient, doc: IDocument, etapa: EtapaBandeja, progreso?: ReturnType<typeof progresoPaciente>) {
  const sucursal = patient.sucursal as unknown as { _id?: Types.ObjectId; nombre?: string; codigo?: string } | undefined;
  return {
    paciente: {
      _id: patient._id,
      nombre: `${patient.nombre} ${patient.apellido}`.trim(),
      rut: patient.rut,
      sucursal: sucursal?.nombre ? { _id: sucursal._id, nombre: sucursal.nombre, codigo: sucursal.codigo } : null,
      progreso: progreso ?? progresoPaciente(patient),
      etapaRegistro: calcularEtapa(patient),
    },
    documento: {
      _id: doc._id,
      tipo: doc.tipo,
      etiqueta: DOCUMENT_TYPE_LABELS[doc.tipo as DocumentType] ?? doc.tipo,
      nombre: doc.nombre,
      fechaSubida: doc.fechaSubida,
      estado: doc.estado,
      generado: !!doc.generado,
      observaciones: doc.observaciones,
      fechaVencimiento: doc.fechaVencimiento,
      // La receta se aprueba con su vencimiento y con lo que autoriza dispensar.
      requiereVencimiento: !!requisitoPara(doc.tipo)?.requiereVencimiento,
      requierePrescripcion: doc.tipo === 'receta_medica',
      prescripcion: doc.prescripcion,
    },
    etapa,
    firmaPaciente: doc.firma
      ? {
          firmadoPor: doc.firma.firmadoPor,
          rutFirmante: doc.firma.rutFirmante,
          fechaFirma: doc.firma.fechaFirma,
          tieneArchivo: !!doc.firma.archivoFirmado,
        }
      : null,
    contrafirma: doc.contrafirma
      ? {
          estado: doc.contrafirma.estado,
          responsable: nombreDe(doc.contrafirma.solicitadoPor),
          responsableId: (doc.contrafirma.solicitadoPor as { _id?: Types.ObjectId } | undefined)?._id ?? doc.contrafirma.solicitadoPor,
          firmadoPor: doc.contrafirma.firmadoPor,
          fechaFirma: doc.contrafirma.fechaFirma,
          signingUrl: doc.contrafirma.estado === 'enviado' ? doc.contrafirma.signingUrl : undefined,
          mensaje: doc.contrafirma.mensaje,
          tieneArchivo: !!doc.contrafirma.archivoFirmado,
        }
      : null,
  };
}

async function pacientesConFirmas(req: AuthRequest) {
  return Patient.find({
    ...getSucursalFilter(req),
    $or: [
      { 'documentos.firma.estado': 'firmado' },
      { documentos: { $elemMatch: { tipo: { $in: TIPOS_REVISION }, estado: 'pendiente' } } },
    ],
  })
    .select('nombre apellido rut estado sucursal documentos')
    .populate('sucursal', 'nombre codigo')
    .populate('documentos.contrafirma.solicitadoPor', 'nombre apellido');
}

// GET /api/validacion-firmas/resumen — cuántos documentos esperan validación (para el menú)
router.get(
  '/resumen',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const cfg = configFirma();
      const activa = cfg.habilitada && cfg.contrafirma;
      let pendientes = 0;
      for (const p of await pacientesConFirmas(req)) {
        for (const d of ultimosPorTipo(p)) {
          const etapa = etapaBandeja(d);
          if (etapa === 'por_revisar' || (activa && ETAPAS_PENDIENTES.includes(etapa))) pendientes++;
        }
      }
      res.json({ activa, pendientes, responsable: !!req.user!.responsableFirma });
    } catch (error) {
      responderErrorFirma(res, error, 'Error al contar documentos por validar');
    }
  }
);

// GET /api/validacion-firmas — bandeja: documentos firmados por pacientes que esperan al dispensario
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  resolveSucursal({ required: false }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const cfg = configFirma();
      const pendientes: ReturnType<typeof itemBandeja>[] = [];
      const validados: ReturnType<typeof itemBandeja>[] = [];
      for (const p of await pacientesConFirmas(req)) {
        const progreso = progresoPaciente(p);
        for (const d of ultimosPorTipo(p)) {
          const etapa = etapaBandeja(d);
          if (etapa === 'por_revisar') {
            pendientes.push(itemBandeja(p, d, etapa, progreso));
            continue;
          }
          if (!tipoRequiereFirma(d.tipo)) continue;
          if (ETAPAS_PENDIENTES.includes(etapa)) pendientes.push(itemBandeja(p, d, etapa, progreso));
          else if (etapa === 'completo' && d.contrafirma?.estado === 'firmado') validados.push(itemBandeja(p, d, etapa, progreso));
        }
      }
      // Lo que lleva más tiempo esperando, primero.
      const fechaPaciente = (i: ReturnType<typeof itemBandeja>) =>
        new Date(i.firmaPaciente?.fechaFirma ?? i.documento.fechaSubida ?? 0).getTime();
      pendientes.sort((a, b) => fechaPaciente(a) - fechaPaciente(b));
      const fechaValidacion = (i: ReturnType<typeof itemBandeja>) => new Date(i.contrafirma?.fechaFirma ?? 0).getTime();
      validados.sort((a, b) => fechaValidacion(b) - fechaValidacion(a));

      res.json({
        activa: cfg.habilitada && cfg.contrafirma,
        responsable: !!req.user!.responsableFirma && ['admin', 'operador'].includes(req.user!.role),
        pendientes,
        validados: validados.slice(0, 20),
      });
    } catch (error) {
      responderErrorFirma(res, error, 'Error al cargar la bandeja de validación');
    }
  }
);

// ─── Certificado del responsable ───────────────────────────

// GET /api/validacion-firmas/certificado — estado de mi certificado de firma
router.get(
  '/certificado',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      exigirResponsable(user);
      const estado = await consultarCertificado(user);
      if (user.isModified()) await user.save();
      res.json(estado);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al consultar tu certificado de firma');
    }
  }
);

// POST /api/validacion-firmas/certificado — pido mi certificado de firma (una sola vez)
router.post(
  '/certificado',
  authenticate,
  authorize('admin', 'operador'),
  [
    body('serieCedula').isString().notEmpty().withMessage('Indica el número de documento de la cédula'),
    body('telefono').optional({ values: 'falsy' }).isString(),
    body('comuna').isString().notEmpty().withMessage('Selecciona tu comuna de residencia'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    try {
      const user = req.user!;
      exigirResponsable(user);
      const result = await solicitarCertificado(user, req.body, retornoFirma.responsableCertificado());
      user.markModified('certificadoFirma');
      await user.save();
      void registrarAuditoria({
        req,
        usuario: user._id as Types.ObjectId,
        accion: 'solicitar_certificado_firma',
        entidad: 'usuario',
        entidadId: user._id as Types.ObjectId,
      });
      res.json(result);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al solicitar tu certificado de firma');
    }
  }
);

// ─── Acciones sobre un documento ───────────────────────────

async function cargar(req: AuthRequest, res: Response): Promise<{ patient: IPatient; doc: IDocument } | null> {
  const { patientId, docId } = req.params as Record<string, string>;
  if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(docId)) {
    res.status(400).json({ message: 'ID inválido.' });
    return null;
  }
  const patient = await Patient.findById(patientId);
  if (!patient) {
    res.status(404).json({ message: 'Paciente no encontrado.' });
    return null;
  }
  if (!canAccessSucursal(req.user, patient.sucursal)) {
    res.status(403).json({ message: 'No tiene acceso a este dispensario.' });
    return null;
  }
  const doc = patient.documentos.id(docId) as IDocument | null;
  if (!doc) {
    res.status(404).json({ message: 'Documento no encontrado.' });
    return null;
  }
  return { patient, doc };
}

async function responderItem(res: Response, patient: IPatient, doc: IDocument, extra: Record<string, unknown> = {}) {
  await patient.populate([
    { path: 'sucursal', select: 'nombre codigo' },
    { path: 'documentos.contrafirma.solicitadoPor', select: 'nombre apellido' },
  ]);
  const actualizado = patient.documentos.id(doc._id) as IDocument;
  res.json({ ...extra, item: itemBandeja(patient, actualizado, etapaBandeja(actualizado)) });
}

// POST /api/validacion-firmas/:patientId/:docId/firmar — el responsable contrafirma
router.post(
  '/:patientId/:docId/firmar',
  authenticate,
  authorize('admin', 'operador'),
  [body('reiniciar').optional().isBoolean()],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    let found: Awaited<ReturnType<typeof cargar>> = null;
    try {
      found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      const user = req.user!;

      // Si aún no tenemos el PDF firmado del paciente (webhook perdido), se intenta traer ahora.
      if (doc.firma?.estado === 'firmado' && !doc.firma.archivoFirmado) {
        await actualizarEstadoFirma(doc).catch(() => false);
      }

      const firma = await solicitarContrafirma(patient, doc, user, {
        redirectUrl: retornoFirma.contrafirma(),
        reiniciar: req.body.reiniciar === true,
      });
      await patient.save();
      if (user.isModified()) await user.save();

      void registrarAuditoria({
        req,
        usuario: user._id as Types.ObjectId,
        accion: 'solicitar_contrafirma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo, reiniciar: !!req.body.reiniciar },
      });
      await responderItem(res, patient, doc, { firma });
    } catch (error) {
      if (found?.patient.isModified()) await found.patient.save().catch(() => undefined);
      if (req.user?.isModified()) await req.user.save().catch(() => undefined);
      responderErrorFirma(res, error, 'Error al solicitar la contrafirma');
    }
  }
);

// POST /api/validacion-firmas/:patientId/:docId/rechazar — devuelve el documento al paciente con el motivo
router.post(
  '/:patientId/:docId/rechazar',
  authenticate,
  authorize('admin', 'operador'),
  [body('motivo').isString().trim().isLength({ min: 3, max: 500 }).withMessage('Escribe el motivo del rechazo')],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    try {
      const found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      await rechazarValidacion(doc, req.user!, String(req.body.motivo));
      await patient.save();
      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'rechazar_validacion_firma',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo, motivo: req.body.motivo },
      });
      await responderItem(res, patient, doc);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al rechazar el documento');
    }
  }
);

// POST /api/validacion-firmas/:patientId/:docId/aprobar — aprueba un documento sin firma
// (certificado de antecedentes, o la receta con su vencimiento y lo que autoriza dispensar)
router.post(
  '/:patientId/:docId/aprobar',
  authenticate,
  authorize('admin', 'operador'),
  [
    body('observaciones').optional().isString().isLength({ max: 500 }),
    body('fechaVencimiento').optional({ values: 'falsy' }).isISO8601().withMessage('Fecha de vencimiento inválida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    if (!validar(req, res)) return;
    try {
      const user = req.user!;
      if (user.role !== 'admin') exigirResponsable(user);
      const found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      if (etapaBandeja(doc) !== 'por_revisar') {
        res.status(409).json({ message: 'Este documento no está esperando revisión.' });
        return;
      }
      if (requisitoPara(doc.tipo)?.requiereVencimiento) {
        if (req.body.fechaVencimiento) doc.fechaVencimiento = new Date(req.body.fechaVencimiento);
        if (!doc.fechaVencimiento) {
          res.status(400).json({ message: 'Indica hasta cuándo es válida la receta.' });
          return;
        }
        if (new Date(doc.fechaVencimiento) < inicioDelDia()) {
          res.status(400).json({ message: 'La receta ya está vencida: recházala para que el paciente suba una vigente.' });
          return;
        }
      }
      if (doc.tipo === 'receta_medica') {
        doc.prescripcion = await leerPrescripcion(req.body.prescripcion, user._id as Types.ObjectId);
      }
      doc.estado = 'aprobado';
      if (req.body.observaciones) doc.observaciones = String(req.body.observaciones);
      doc.revisadoPor = user._id as Types.ObjectId;
      doc.fechaRevision = new Date();
      reactivarSiCorresponde(patient, user._id as Types.ObjectId);
      await patient.save();
      void registrarAuditoria({
        req,
        usuario: user._id as Types.ObjectId,
        accion: 'revisar_documento',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, tipo: doc.tipo, estado: 'aprobado', desde: 'bandeja' },
      });
      await responderItem(res, patient, doc);
    } catch (error) {
      if (error instanceof PrescripcionError) {
        res.status(400).json({ message: error.message });
        return;
      }
      responderErrorFirma(res, error, 'Error al aprobar el documento');
    }
  }
);

// GET /api/validacion-firmas/:patientId/:docId/estado — consulta la contrafirma en Signapis
router.get(
  '/:patientId/:docId/estado',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      if (await actualizarContrafirma(patient, doc)) await patient.save();
      await responderItem(res, patient, doc);
    } catch (error) {
      responderErrorFirma(res, error, 'Error al consultar la contrafirma');
    }
  }
);

// GET /api/validacion-firmas/:patientId/:docId/archivo?version=paciente|final — enlace temporal al PDF
router.get(
  '/:patientId/:docId/archivo',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const found = await cargar(req, res);
      if (!found) return;
      const { patient, doc } = found;
      const final = req.query.version === 'final';
      const ref = final ? doc.contrafirma?.archivoFirmado : doc.firma?.archivoFirmado ?? doc.archivo;
      const url = ref ? await getDownloadUrl(ref, baseUrl(req)) : null;
      if (!url) {
        res.status(404).json({ message: 'El archivo no está disponible.' });
        return;
      }
      void registrarAuditoria({
        req,
        usuario: req.user!._id as Types.ObjectId,
        accion: 'ver_documento',
        entidad: 'paciente',
        entidadId: patient._id as Types.ObjectId,
        sucursal: patient.sucursal,
        detalles: { documento: doc._id, version: final ? 'contrafirmado' : 'firmado_paciente' },
      });
      res.json({ url });
    } catch (error) {
      responderErrorFirma(res, error, 'Error al abrir el documento');
    }
  }
);

export default router;
