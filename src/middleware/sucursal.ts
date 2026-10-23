import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { Sucursal } from '../models/Sucursal';
import { AuthRequest } from './auth';
import { IUser } from '../models/User';

/**
 * Lee el header X-Sucursal-Id y valida que el usuario tenga acceso.
 * Deja el resultado en req.sucursalId.
 */
export const resolveSucursal = (opts: { required?: boolean } = {}) => {
  const { required = true } = opts;

  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const sucursalId = req.header('X-Sucursal-Id');

    if (req.user?.role === 'paciente') {
      if (sucursalId && mongoose.Types.ObjectId.isValid(sucursalId)) {
        req.sucursalId = new mongoose.Types.ObjectId(sucursalId);
      }
      return next();
    }

    // Admin sin sucursal seleccionada ve todo. Las rutas que crean registros validan req.sucursalId por su cuenta.
    if (req.user?.role === 'admin' && !sucursalId) {
      return next();
    }

    if (sucursalId) {
      if (!mongoose.Types.ObjectId.isValid(sucursalId)) {
        res.status(400).json({ message: 'X-Sucursal-Id inválido.' });
        return;
      }

      const oid = new mongoose.Types.ObjectId(sucursalId);

      if (req.user?.role !== 'admin' && !canAccessSucursal(req.user, oid)) {
        res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
        return;
      }

      const exists = await Sucursal.exists({ _id: oid, activo: true });
      if (!exists) {
        res.status(404).json({ message: 'Sucursal no encontrada o inactiva.' });
        return;
      }

      req.sucursalId = oid;
      return next();
    }

    if (required) {
      res.status(400).json({ message: 'Debe seleccionar una sucursal (header X-Sucursal-Id).' });
      return;
    }

    next();
  };
};

/** true si el usuario puede ver o modificar datos de esa sucursal. */
export function canAccessSucursal(
  user: IUser | undefined,
  sucursal: mongoose.Types.ObjectId | string | null | undefined
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!sucursal) return false;
  return (user.sucursales || []).map(String).includes(String(sucursal));
}

/**
 * Filtro por sucursal para consultas.
 * - Con sucursal seleccionada: solo esa.
 * - Admin sin selección: todas.
 * - Resto del personal sin selección: solo sus sucursales asignadas.
 * @param field nombre del campo en el modelo (por defecto "sucursal").
 */
export const getSucursalFilter = (req: AuthRequest, field = 'sucursal'): Record<string, unknown> => {
  if (req.sucursalId) {
    return { [field]: req.sucursalId };
  }
  if (req.user && req.user.role !== 'admin' && req.user.role !== 'paciente') {
    return { [field]: { $in: req.user.sucursales || [] } };
  }
  return {};
};
