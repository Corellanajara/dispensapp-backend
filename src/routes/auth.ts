import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { User, UserRole, USER_ROLES } from '../models/User';
import { Patient } from '../models/Patient';
import { Sucursal } from '../models/Sucursal';
import { env } from '../config/env';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { registrarAuditoria } from '../services/audit';

const router = Router();

const generateToken = (id: string, role: string): string => {
  return jwt.sign({ id, role }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
};

// POST /api/auth/register — crea usuarios internos. Solo un administrador puede hacerlo.
router.post(
  '/register',
  authenticate,
  authorize('admin'),
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password').isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres'),
    body('nombre').notEmpty().withMessage('Nombre es requerido'),
    body('apellido').notEmpty().withMessage('Apellido es requerido'),
    body('rut').notEmpty().withMessage('RUT es requerido'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const { email, password, nombre, apellido, rut, role, telefono, sucursales } = req.body;

      const resolvedRole = (role || 'operador') as UserRole;
      if (!USER_ROLES.includes(resolvedRole)) {
        res.status(400).json({ message: 'Rol inválido.' });
        return;
      }
      if (resolvedRole === 'paciente') {
        res.status(400).json({
          message:
            'No se puede crear un paciente desde aquí. Usa el registro de pacientes o el enlace de registro del portal; allí se crea la cuenta y la ficha clínica vinculadas.',
        });
        return;
      }

      const existingUser = await User.findOne({ $or: [{ email }, { rut }] });
      if (existingUser) {
        res.status(400).json({ message: 'El email o RUT ya está registrado.' });
        return;
      }

      const user = new User({
        email,
        password,
        nombre,
        apellido,
        rut,
        role: resolvedRole,
        telefono,
        sucursales: Array.isArray(sucursales) ? sucursales : [],
      });

      await user.save();

      await registrarAuditoria({
        req,
        usuario: String(req.user!._id),
        accion: 'crear',
        entidad: 'usuario',
        entidadId: String(user._id),
        detalles: { email, role: resolvedRole },
      });

      // No se devuelve token: quien crea la cuenta es el admin, no el nuevo usuario.
      res.status(201).json({
        user: {
          id: user._id,
          email: user.email,
          nombre: user.nombre,
          apellido: user.apellido,
          role: user.role,
          sucursales: user.sucursales || [],
          sucursalActiva: user.sucursalActiva || null,
        },
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ message: 'Error al registrar usuario.' });
    }
  }
);

// POST /api/auth/register-patient
router.post(
  '/register-patient',
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password').isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres'),
    body('nombre').notEmpty().withMessage('Nombre es requerido'),
    body('apellido').notEmpty().withMessage('Apellido es requerido'),
    body('rut').notEmpty().withMessage('RUT es requerido'),
    body('telefono').notEmpty().withMessage('Teléfono es requerido'),
    body('fechaNacimiento').isISO8601().withMessage('Fecha de nacimiento inválida'),
    body('direccion.calle').notEmpty().withMessage('Calle es requerida'),
    body('direccion.numero').notEmpty().withMessage('Número es requerido'),
    body('direccion.comuna').notEmpty().withMessage('Comuna es requerida'),
    body('direccion.ciudad').notEmpty().withMessage('Ciudad es requerida'),
    body('direccion.region').notEmpty().withMessage('Región es requerida'),
    body('medicoTratante.nombre').notEmpty().withMessage('Nombre del médico es requerido'),
    body('sucursal').isMongoId().withMessage('Selecciona tu dispensario'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const { email, password, nombre, apellido, rut, telefono, fechaNacimiento, direccion, medicoTratante, sucursal } =
        req.body;

      if (!(await Sucursal.exists({ _id: sucursal, activo: true }))) {
        res.status(400).json({ message: 'El dispensario seleccionado no existe o no está activo.' });
        return;
      }

      // Check uniqueness in both User and Patient collections
      const [existingUser, existingPatient] = await Promise.all([
        User.findOne({ $or: [{ email }, { rut }] }),
        Patient.findOne({ $or: [{ email }, { rut }] }),
      ]);

      if (existingUser) {
        res.status(400).json({ message: 'El email o RUT ya está registrado como usuario.' });
        return;
      }
      if (existingPatient) {
        res.status(400).json({ message: 'El email o RUT ya está registrado como paciente.' });
        return;
      }

      // Create User with role paciente
      const user = new User({
        email,
        password,
        nombre,
        apellido,
        rut,
        role: 'paciente',
        telefono,
      });
      await user.save();

      // Create Patient linked to user
      try {
        const patient = new Patient({
          usuario: user._id,
          sucursal,
          rut,
          nombre,
          apellido,
          fechaNacimiento,
          direccion,
          telefono,
          email,
          medicoTratante,
          estado: 'pendiente',
          historialEstados: [{ estado: 'pendiente', fecha: new Date(), usuario: user._id, motivo: 'Registro en el portal' }],
        });
        await patient.save();
      } catch (patientError) {
        // Manual rollback: delete the user if patient creation fails
        await User.findByIdAndDelete(user._id);
        console.error('Create patient error (rollback):', patientError);
        res.status(500).json({ message: 'Error al crear registro de paciente.' });
        return;
      }

      const token = generateToken(String(user._id), user.role);

      res.status(201).json({
        token,
        user: {
          id: user._id,
          email: user.email,
          nombre: user.nombre,
          apellido: user.apellido,
          role: user.role,
          sucursales: [],
          sucursalActiva: sucursal,
        },
      });
    } catch (error) {
      console.error('Register patient error:', error);
      res.status(500).json({ message: 'Error al registrar paciente.' });
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password').notEmpty().withMessage('Contraseña es requerida'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const { email, password } = req.body;
      const emailNorm = String(email).toLowerCase().trim();

      const fallo = (motivo: string, usuario?: string) =>
        registrarAuditoria({
          req,
          usuario,
          email: emailNorm,
          accion: 'login',
          entidad: 'sesion',
          resultado: 'fallo',
          detalles: { motivo },
        });

      const user = await User.findOne({ email: emailNorm });
      if (!user) {
        await fallo('usuario_inexistente');
        res.status(401).json({ message: 'Credenciales inválidas.' });
        return;
      }

      if (user.bloqueadoHasta && user.bloqueadoHasta > new Date()) {
        await fallo('cuenta_bloqueada', String(user._id));
        const minutos = Math.ceil((user.bloqueadoHasta.getTime() - Date.now()) / 60000);
        res.status(423).json({
          message: `Cuenta bloqueada por intentos fallidos. Intenta de nuevo en ${minutos} minuto(s).`,
        });
        return;
      }

      if (!user.activo) {
        await fallo('cuenta_desactivada', String(user._id));
        res.status(401).json({ message: 'Cuenta desactivada.' });
        return;
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        user.intentosFallidos = (user.intentosFallidos || 0) + 1;
        let bloqueada = false;
        if (user.intentosFallidos >= env.LOGIN_MAX_INTENTOS) {
          user.bloqueadoHasta = new Date(Date.now() + env.LOGIN_BLOQUEO_MINUTOS * 60000);
          user.intentosFallidos = 0;
          bloqueada = true;
        }
        await user.save();
        await fallo(bloqueada ? 'contrasena_incorrecta_bloqueo' : 'contrasena_incorrecta', String(user._id));
        if (bloqueada) {
          await registrarAuditoria({
            req,
            usuario: String(user._id),
            email: emailNorm,
            accion: 'bloqueo_cuenta',
            entidad: 'usuario',
            entidadId: String(user._id),
            resultado: 'fallo',
            detalles: { minutos: env.LOGIN_BLOQUEO_MINUTOS },
          });
          res.status(423).json({
            message: `Demasiados intentos fallidos. La cuenta quedó bloqueada ${env.LOGIN_BLOQUEO_MINUTOS} minutos.`,
          });
          return;
        }
        res.status(401).json({ message: 'Credenciales inválidas.' });
        return;
      }

      user.intentosFallidos = 0;
      user.bloqueadoHasta = undefined;
      user.ultimoAcceso = new Date();
      await user.save();

      const populatedUser = await User.findById(user._id).populate('sucursales', 'nombre codigo');

      const token = generateToken(String(user._id), user.role);

      await registrarAuditoria({
        req,
        usuario: String(user._id),
        email: emailNorm,
        accion: 'login',
        entidad: 'sesion',
        sucursal: user.sucursalActiva,
      });

      res.json({
        token,
        user: {
          id: user._id,
          email: user.email,
          nombre: user.nombre,
          apellido: user.apellido,
          role: user.role,
          sucursales: populatedUser?.sucursales || [],
          sucursalActiva: populatedUser?.sucursalActiva || null,
        },
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ message: 'Error al iniciar sesión.' });
    }
  }
);

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.user!._id).populate('sucursales', 'nombre codigo');
    res.json({ user });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Error al obtener usuario.' });
  }
});

// PATCH /api/auth/sucursal-activa
router.patch(
  '/sucursal-activa',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const { sucursalId } = req.body;
      if (!sucursalId) {
        res.status(400).json({ message: 'sucursalId es requerido.' });
        return;
      }

      const user = req.user!;

      if (user.role !== 'admin') {
        const userSucursales = (user.sucursales || []).map(String);
        if (!userSucursales.includes(String(sucursalId))) {
          res.status(403).json({ message: 'No tiene acceso a esta sucursal.' });
          return;
        }
      }

      user.sucursalActiva = sucursalId;
      await user.save();

      const updated = await User.findById(user._id).populate('sucursales', 'nombre codigo');
      res.json({ user: updated });
    } catch (error) {
      console.error('Set active sucursal error:', error);
      res.status(500).json({ message: 'Error al cambiar sucursal activa.' });
    }
  }
);

export default router;
