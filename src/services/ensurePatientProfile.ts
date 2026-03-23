import mongoose from 'mongoose';
import { Patient, IPatient } from '../models/Patient';
import { IUser } from '../models/User';

/** Fecha placeholder cuando el paciente se creó solo como usuario (sin registro completo). */
const PLACEHOLDER_FECHA_NACIMIENTO = new Date('1900-01-01T00:00:00.000Z');

/**
 * Devuelve el Patient vinculado al usuario, creándolo o enlazando por RUT si hace falta.
 * Casos cubiertos:
 * - Usuario creado como "paciente" desde admin sin documento Patient
 * - Ficha Patient creada por operador sin campo `usuario`, mismo RUT que el User
 */
export async function ensurePatientProfileForUser(user: IUser): Promise<IPatient | null> {
  if (user.role !== 'paciente') {
    return null;
  }

  let patient = await Patient.findOne({ usuario: user._id });
  if (patient) {
    return patient;
  }

  const rut = user.rut.trim();
  const byRut = await Patient.findOne({ rut });
  if (byRut) {
    if (!byRut.usuario) {
      byRut.usuario = user._id as mongoose.Types.ObjectId;
      await byRut.save();
      return byRut;
    }
    if (byRut.usuario.equals(user._id)) {
      return byRut;
    }
    return null;
  }

  patient = new Patient({
    usuario: user._id,
    rut,
    nombre: user.nombre,
    apellido: user.apellido,
    fechaNacimiento: PLACEHOLDER_FECHA_NACIMIENTO,
    email: user.email,
    telefono: user.telefono?.trim() || 'Pendiente',
    direccion: {
      calle: 'Pendiente',
      numero: '—',
      comuna: 'Pendiente',
      ciudad: 'Pendiente',
      region: 'Pendiente',
    },
    medicoTratante: { nombre: 'Pendiente' },
    estado: 'pendiente',
    limiteCompra: 0,
  });

  try {
    await patient.save();
  } catch (err) {
    console.error('ensurePatientProfileForUser:', err);
    return null;
  }

  return patient;
}
