import { randomInt } from 'crypto';
import { IUser } from '../models/User';
import { env } from '../config/env';

/** Sin caracteres que se confunden al dictarla o leerla (0/O, 1/l/I). */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** Clave temporal legible, p. ej. "Kf7m-Q2xp-Rt4w" (12 caracteres aleatorios, ~70 bits). */
export function generarClaveTemporal(): string {
  const grupos: string[] = [];
  for (let g = 0; g < 3; g++) {
    let grupo = '';
    for (let i = 0; i < 4; i++) grupo += ALFABETO[randomInt(ALFABETO.length)];
    grupos.push(grupo);
  }
  return grupos.join('-');
}

/**
 * Reemplaza la clave del usuario por una temporal que debe cambiar al entrar.
 * Desbloquea la cuenta y deja sin efecto las sesiones abiertas. No guarda: el llamador hace save().
 */
export function asignarClaveTemporal(user: IUser): { clave: string; expira: Date } {
  const clave = generarClaveTemporal();
  const expira = new Date(Date.now() + env.CLAVE_TEMPORAL_HORAS * 3600_000);
  user.password = clave;
  user.debeCambiarPassword = true;
  user.passwordTemporalExpira = expira;
  user.credencialesCambiadasEn = new Date();
  user.intentosFallidos = 0;
  user.bloqueadoHasta = undefined;
  return { clave, expira };
}

/** Deja la clave definitiva elegida por el usuario. No guarda: el llamador hace save(). */
export function asignarClaveDefinitiva(user: IUser, nueva: string): void {
  user.password = nueva;
  user.debeCambiarPassword = false;
  user.passwordTemporalExpira = undefined;
  user.credencialesCambiadasEn = new Date();
}

/** El token se emitió antes del último cambio de clave (iat en segundos). */
export function tokenAnteriorAlCambio(user: IUser, iat?: number): boolean {
  if (!user.credencialesCambiadasEn || !iat) return false;
  return iat < Math.floor(user.credencialesCambiadasEn.getTime() / 1000);
}

export const CLAVE_MINIMA = 8;
