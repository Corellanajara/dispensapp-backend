import nodemailer, { Transporter } from 'nodemailer';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { Notificacion } from '../models/Notificacion';
import { User } from '../models/User';

/**
 * Notificaciones: aviso dentro de la app y, si hay SMTP configurado, también por correo.
 * Nunca hacen fallar la operación que las origina: los errores solo se registran en el log.
 */

export interface Aviso {
  tipo: string;
  titulo: string;
  mensaje: string;
  /** Ruta del frontend, ej. "/portal/perfil". */
  enlace?: string;
  paciente?: Types.ObjectId;
}

interface Destinatario {
  usuario?: Types.ObjectId | null;
  email?: string | null;
}

let transporte: Transporter | null | undefined;

function correo(): Transporter | null {
  if (transporte !== undefined) return transporte;
  if (!env.SMTP_HOST || !env.SMTP_FROM) {
    transporte = null;
    console.log('[notificaciones] Sin SMTP_HOST/SMTP_FROM: los avisos quedan solo en la app.');
    return null;
  }
  transporte = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporte;
}

export function correoConfigurado(): boolean {
  return !!correo();
}

const escapar = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function enviarCorreo(para: string, aviso: Aviso): Promise<void> {
  const t = correo();
  if (!t) return;
  const url = aviso.enlace ? `${env.FRONTEND_URL}${aviso.enlace}` : env.FRONTEND_URL;
  await t.sendMail({
    from: env.SMTP_FROM,
    to: para,
    subject: aviso.titulo,
    text: `${aviso.mensaje}\n\nIngresa a Dispensapp: ${url}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:560px">
<h2 style="font-size:18px;margin:0 0 12px">${escapar(aviso.titulo)}</h2>
<p style="line-height:1.5;margin:0 0 20px">${escapar(aviso.mensaje)}</p>
<p><a href="${escapar(url)}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Abrir Dispensapp</a></p>
<p style="color:#6b7280;font-size:12px;margin-top:28px">Este es un aviso automático de Dispensapp.</p>
</div>`,
  });
}

/** Guarda el aviso en la app para cada destinatario con usuario y lo envía por correo a quien tenga email. */
export async function notificar(destinatarios: Destinatario[], aviso: Aviso): Promise<void> {
  const usuarios = [...new Set(destinatarios.map((d) => d.usuario?.toString()).filter(Boolean) as string[])];
  const correos = [...new Set(destinatarios.map((d) => d.email?.trim().toLowerCase()).filter(Boolean) as string[])];
  try {
    if (usuarios.length) {
      await Notificacion.insertMany(
        usuarios.map((id) => ({
          destinatario: id,
          tipo: aviso.tipo,
          titulo: aviso.titulo,
          mensaje: aviso.mensaje,
          enlace: aviso.enlace,
          paciente: aviso.paciente,
        }))
      );
    }
  } catch (err) {
    console.error('[notificaciones] No se pudo guardar el aviso:', (err as Error).message);
  }
  for (const email of correos) {
    await enviarCorreo(email, aviso).catch((err) =>
      console.error(`[notificaciones] No se pudo enviar el correo "${aviso.tipo}":`, (err as Error).message)
    );
  }
}

/**
 * Personal que debe enterarse de un paciente: administradores y responsables de firma
 * con acceso al dispensario del paciente.
 */
export async function personalDelPaciente(sucursal?: Types.ObjectId | null): Promise<Destinatario[]> {
  const filtro: Record<string, unknown>[] = [{ role: 'admin' }];
  if (sucursal) filtro.push({ role: 'operador', responsableFirma: true, sucursales: sucursal });
  const usuarios = await User.find({ activo: true, $or: filtro }).select('_id email');
  return usuarios.map((u) => ({ usuario: u._id as Types.ObjectId, email: u.email }));
}
