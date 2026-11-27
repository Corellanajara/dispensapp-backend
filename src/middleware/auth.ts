import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { User, IUser, UserRole } from '../models/User';
import { tokenAnteriorAlCambio } from '../services/claves';

export interface AuthRequest extends Request {
  user?: IUser;
  sucursalId?: mongoose.Types.ObjectId;
}

interface JwtPayload {
  id: string;
  role: UserRole;
  iat?: number;
}

/** Lo único que puede hacer quien entró con una clave temporal: ver su sesión y cambiarla. */
const PERMITIDO_CON_CLAVE_TEMPORAL = ['/api/auth/me', '/api/auth/cambiar-password'];

export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ message: 'Acceso denegado. Token no proporcionado.' });
      return;
    }

    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    const user = await User.findById(decoded.id);

    if (!user || !user.activo) {
      res.status(401).json({ message: 'Token inválido o usuario inactivo.' });
      return;
    }

    // La clave se cambió o reinició después de emitir este token: la sesión ya no vale.
    if (tokenAnteriorAlCambio(user, decoded.iat)) {
      res.status(401).json({ message: 'Tu clave cambió. Inicia sesión de nuevo.' });
      return;
    }

    if (user.debeCambiarPassword && !PERMITIDO_CON_CLAVE_TEMPORAL.includes(req.originalUrl.split('?')[0])) {
      res.status(403).json({
        message: 'Debes cambiar tu clave temporal antes de continuar.',
        codigo: 'DEBE_CAMBIAR_PASSWORD',
      });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido.' });
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'No autenticado.' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ message: 'No tiene permisos para esta acción.' });
      return;
    }

    next();
  };
};
