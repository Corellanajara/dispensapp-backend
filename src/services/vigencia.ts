import { Types } from 'mongoose';
import { Patient, IPatient, IDocument } from '../models/Patient';
import { documentosRequeridos } from './configuracion';
import { env } from '../config/env';
import { registrarAuditoria } from './audit';

/** Inicio del día (UTC). Una receta es vigente hasta el final de su fecha de vencimiento. */
export function inicioDelDia(fecha = new Date()): Date {
  const d = new Date(fecha);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Receta aprobada con vencimiento más lejano que aún no vence, o null. */
export function recetaVigente(patient: Pick<IPatient, 'documentos'>, fecha = new Date()): IDocument | null {
  const hoy = inicioDelDia(fecha);
  const vigentes = (patient.documentos || []).filter(
    (d) =>
      d.tipo === 'receta_medica' &&
      d.estado === 'aprobado' &&
      d.fechaVencimiento &&
      new Date(d.fechaVencimiento) >= hoy
  );
  if (vigentes.length === 0) return null;
  return vigentes.sort(
    (a, b) => new Date(b.fechaVencimiento!).getTime() - new Date(a.fechaVencimiento!).getTime()
  )[0];
}

export interface RequisitosActivacion {
  /** Faltantes que impiden activar. */
  bloqueantes: string[];
  /** Faltantes que solo se advierten. */
  advertencias: string[];
}

/**
 * Revisa los documentos exigidos para activar al paciente (ver config/documentos.ts).
 * La firma se exige solo si el administrador la tiene activa para ese tipo de documento.
 */
export function verificarRequisitosActivacion(patient: Pick<IPatient, 'documentos'>): RequisitosActivacion {
  const bloqueantes: string[] = [];
  const advertencias: string[] = [];

  for (const req of documentosRequeridos()) {
    let cumple: boolean;
    let detalle = req.label;

    if (req.tipo === 'receta_medica') {
      cumple = recetaVigente(patient) !== null;
      detalle = `${req.label} aprobada y vigente`;
    } else {
      const docs = (patient.documentos || []).filter((d) => d.tipo === req.tipo && d.estado === 'aprobado');
      cumple = docs.length > 0 && (!req.requiereFirma || docs.some((d) => d.firma?.estado === 'firmado'));
      detalle = req.requiereFirma ? `${req.label} aprobado y firmado` : `${req.label} aprobado`;
    }

    if (!cumple) {
      (req.bloqueaActivacion ? bloqueantes : advertencias).push(detalle);
    }
  }

  return { bloqueantes, advertencias };
}

/**
 * Suspende a los pacientes activos cuya receta venció y no tienen otra vigente.
 * No toca a pacientes sin receta con fecha (fichas antiguas): a ellos solo se les bloquea la dispensación.
 */
export async function revisarVigencias(): Promise<number> {
  const hoy = inicioDelDia();

  const vencidos = await Patient.find({
    estado: 'aprobado',
    $and: [
      {
        documentos: {
          $elemMatch: { tipo: 'receta_medica', estado: 'aprobado', fechaVencimiento: { $lt: hoy } },
        },
      },
      {
        documentos: {
          $not: {
            $elemMatch: { tipo: 'receta_medica', estado: 'aprobado', fechaVencimiento: { $gte: hoy } },
          },
        },
      },
    ],
  });

  for (const patient of vencidos) {
    patient.estado = 'suspendido';
    patient.motivoSuspension = 'receta_vencida';
    patient.historialEstados.push({
      estado: 'suspendido',
      fecha: new Date(),
      motivo: 'Receta vencida (suspensión automática)',
    });
    await patient.save();

    await registrarAuditoria({
      accion: 'suspension_automatica',
      entidad: 'paciente',
      entidadId: patient._id as Types.ObjectId,
      sucursal: patient.sucursal,
      detalles: { motivo: 'receta_vencida' },
    });
  }

  if (vencidos.length > 0) {
    console.log(`[vigencia] ${vencidos.length} paciente(s) suspendido(s) por receta vencida`);
  }
  return vencidos.length;
}

/**
 * Si el paciente estaba suspendido por receta vencida y ahora tiene una vigente, lo reactiva.
 * Controlado por REACTIVAR_AL_RENOVAR_RECETA (por defecto activo).
 * @returns true si lo reactivó (el llamador debe guardar el documento).
 */
export function reactivarSiCorresponde(patient: IPatient, usuario: Types.ObjectId): boolean {
  if (!env.REACTIVAR_AL_RENOVAR_RECETA) return false;
  if (patient.estado !== 'suspendido' || patient.motivoSuspension !== 'receta_vencida') return false;
  if (!recetaVigente(patient)) return false;

  patient.estado = 'aprobado';
  patient.motivoSuspension = undefined;
  patient.historialEstados.push({
    estado: 'aprobado',
    fecha: new Date(),
    usuario,
    motivo: 'Reactivado al aprobar una receta vigente',
  });
  return true;
}

/** Datos para el panel de avisos de vigencia. */
export async function alertasVigencia(filtroSucursal: Record<string, unknown>) {
  const hoy = inicioDelDia();
  const limite = new Date(hoy);
  limite.setUTCDate(limite.getUTCDate() + env.DIAS_AVISO_RECETA);

  const select = 'nombre apellido rut estado motivoSuspension sucursal documentos';

  const [activos, suspendidos] = await Promise.all([
    Patient.find({ ...filtroSucursal, estado: 'aprobado' }).select(select).populate('sucursal', 'nombre codigo'),
    Patient.find({ ...filtroSucursal, estado: 'suspendido', motivoSuspension: 'receta_vencida' })
      .select(select)
      .populate('sucursal', 'nombre codigo'),
  ]);

  const resumen = (p: IPatient) => {
    const receta = recetaVigente(p);
    return {
      _id: p._id,
      nombre: p.nombre,
      apellido: p.apellido,
      rut: p.rut,
      estado: p.estado,
      sucursal: p.sucursal,
      recetaVence: receta?.fechaVencimiento || null,
    };
  };

  const porVencer = activos
    .filter((p) => {
      const r = recetaVigente(p);
      return r && new Date(r.fechaVencimiento!) <= limite;
    })
    .map(resumen)
    .sort((a, b) => new Date(a.recetaVence!).getTime() - new Date(b.recetaVence!).getTime());

  const sinRecetaVigente = activos.filter((p) => !recetaVigente(p)).map(resumen);

  return {
    diasAviso: env.DIAS_AVISO_RECETA,
    porVencer,
    sinRecetaVigente,
    suspendidosPorVencimiento: suspendidos.map(resumen),
  };
}

/** Inicia la revisión periódica (al arrancar y cada hora). */
export function iniciarRevisionVigencias(): void {
  const run = () => revisarVigencias().catch((err) => console.error('[vigencia] error:', err));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}
