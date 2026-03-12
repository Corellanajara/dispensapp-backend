import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { User } from '../models/User';
import { Patient } from '../models/Patient';
import { env } from '../config/env';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

const generateToken = (id: string, role: string): string => {
  return jwt.sign({ id, role }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
};

// POST /api/auth/register
router.post(
  '/register',
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
      const { email, password, nombre, apellido, rut, role, telefono } = req.body;

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
        role: role || 'operador',
        telefono,
      });

      await user.save();

      const token = generateToken(String(user._id), user.role);

      res.status(201).json({
        token,
        user: {
          id: user._id,
          email: user.email,
          nombre: user.nombre,
          apellido: user.apellido,
          role: user.role,
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
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const { email, password, nombre, apellido, rut, telefono, fechaNacimiento, direccion, medicoTratante } = req.body;

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
          rut,
          nombre,
          apellido,
          fechaNacimiento,
          direccion,
          telefono,
          email,
          medicoTratante,
          estado: 'pendiente',
          limiteCompra: 0,
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

      const user = await User.findOne({ email });
      if (!user) {
        res.status(401).json({ message: 'Credenciales inválidas.' });
        return;
      }

      if (!user.activo) {
        res.status(401).json({ message: 'Cuenta desactivada.' });
        return;
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        res.status(401).json({ message: 'Credenciales inválidas.' });
        return;
      }

      user.ultimoAcceso = new Date();
      await user.save();

      const token = generateToken(String(user._id), user.role);

      res.json({
        token,
        user: {
          id: user._id,
          email: user.email,
          nombre: user.nombre,
          apellido: user.apellido,
          role: user.role,
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
    res.json({ user: req.user });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Error al obtener usuario.' });
  }
});

export default router;
