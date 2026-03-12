import { Router, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { Patient } from '../models/Patient';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { upload } from '../middleware/upload';

const router = Router();

// GET /api/patients
router.get(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const {
        page = '1',
        limit = '20',
        estado,
        search,
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = {};
      if (estado) filter.estado = estado;
      if (search) {
        filter.$or = [
          { nombre: { $regex: search, $options: 'i' } },
          { apellido: { $regex: search, $options: 'i' } },
          { rut: { $regex: search, $options: 'i' } },
        ];
      }

      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);

      const [patients, total] = await Promise.all([
        Patient.find(filter)
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum),
        Patient.countDocuments(filter),
      ]);

      res.json({
        data: patients,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get patients error:', error);
      res.status(500).json({ message: 'Error al obtener pacientes.' });
    }
  }
);

// GET /api/patients/me
router.get(
  '/me',
  authenticate,
  authorize('paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await Patient.findOne({ usuario: req.user!._id });
      if (!patient) {
        res.status(404).json({ message: 'Perfil de paciente no encontrado.' });
        return;
      }
      res.json(patient);
    } catch (error) {
      console.error('Get patient profile error:', error);
      res.status(500).json({ message: 'Error al obtener perfil de paciente.' });
    }
  }
);

// PUT /api/patients/me
router.put(
  '/me',
  authenticate,
  authorize('paciente'),
  auditLog('actualizar', 'paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const update: Record<string, unknown> = {};
      if (req.body.telefono !== undefined) update.telefono = req.body.telefono;
      if (req.body.direccion !== undefined) update.direccion = req.body.direccion;
      if (req.body.medicoTratante !== undefined) update.medicoTratante = req.body.medicoTratante;

      const patient = await Patient.findOneAndUpdate(
        { usuario: req.user!._id },
        update,
        { new: true, runValidators: true }
      );
      if (!patient) {
        res.status(404).json({ message: 'Perfil de paciente no encontrado.' });
        return;
      }
      res.json(patient);
    } catch (error) {
      console.error('Update patient profile error:', error);
      res.status(500).json({ message: 'Error al actualizar perfil de paciente.' });
    }
  }
);

// POST /api/patients/me/documents
router.post(
  '/me/documents',
  authenticate,
  authorize('paciente'),
  auditLog('subir_documento', 'paciente'),
  upload.single('archivo'),
  [
    body('tipo')
      .isIn(['receta_medica', 'certificado_antecedentes', 'cedula_identidad', 'otro'])
      .withMessage('Tipo de documento inválido'),
    body('nombre').notEmpty().withMessage('Nombre del documento es requerido'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const patient = await Patient.findOne({ usuario: req.user!._id });
      if (!patient) {
        res.status(404).json({ message: 'Perfil de paciente no encontrado.' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ message: 'Archivo es requerido.' });
        return;
      }

      patient.documentos.push({
        tipo: req.body.tipo,
        nombre: req.body.nombre,
        archivo: req.file.path,
        fechaSubida: new Date(),
        fechaVencimiento: req.body.fechaVencimiento ? new Date(req.body.fechaVencimiento) : undefined,
        estado: 'pendiente',
        observaciones: req.body.observaciones,
      });

      await patient.save();
      res.status(201).json(patient);
    } catch (error) {
      console.error('Upload patient document error:', error);
      res.status(500).json({ message: 'Error al subir documento.' });
    }
  }
);

// GET /api/patients/:id
router.get(
  '/:id',
  authenticate,
  authorize('admin', 'operador'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await Patient.findById(req.params.id).populate('usuario', 'email nombre apellido');
      if (!patient) {
        res.status(404).json({ message: 'Paciente no encontrado.' });
        return;
      }
      res.json(patient);
    } catch (error) {
      console.error('Get patient error:', error);
      res.status(500).json({ message: 'Error al obtener paciente.' });
    }
  }
);

// POST /api/patients
router.post(
  '/',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('crear', 'paciente'),
  [
    body('rut').notEmpty().withMessage('RUT es requerido'),
    body('nombre').notEmpty().withMessage('Nombre es requerido'),
    body('apellido').notEmpty().withMessage('Apellido es requerido'),
    body('fechaNacimiento').isISO8601().withMessage('Fecha de nacimiento inválida'),
    body('telefono').notEmpty().withMessage('Teléfono es requerido'),
    body('email').isEmail().withMessage('Email inválido'),
    body('medicoTratante.nombre').notEmpty().withMessage('Nombre del médico es requerido'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const existing = await Patient.findOne({ rut: req.body.rut });
      if (existing) {
        res.status(400).json({ message: 'Ya existe un paciente con este RUT.' });
        return;
      }

      const patient = new Patient(req.body);
      await patient.save();
      res.status(201).json(patient);
    } catch (error) {
      console.error('Create patient error:', error);
      res.status(500).json({ message: 'Error al crear paciente.' });
    }
  }
);

// PUT /api/patients/:id
router.put(
  '/:id',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('actualizar', 'paciente'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const patient = await Patient.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });
      if (!patient) {
        res.status(404).json({ message: 'Paciente no encontrado.' });
        return;
      }
      res.json(patient);
    } catch (error) {
      console.error('Update patient error:', error);
      res.status(500).json({ message: 'Error al actualizar paciente.' });
    }
  }
);

// PATCH /api/patients/:id/status
router.patch(
  '/:id/status',
  authenticate,
  authorize('admin'),
  auditLog('cambiar_estado', 'paciente'),
  [body('estado').isIn(['pendiente', 'aprobado', 'rechazado', 'suspendido']).withMessage('Estado inválido')],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const patient = await Patient.findByIdAndUpdate(
        req.params.id,
        { estado: req.body.estado, observaciones: req.body.observaciones },
        { new: true }
      );
      if (!patient) {
        res.status(404).json({ message: 'Paciente no encontrado.' });
        return;
      }
      res.json(patient);
    } catch (error) {
      console.error('Update patient status error:', error);
      res.status(500).json({ message: 'Error al actualizar estado.' });
    }
  }
);

// POST /api/patients/:id/documents
router.post(
  '/:id/documents',
  authenticate,
  authorize('admin', 'operador'),
  auditLog('subir_documento', 'paciente'),
  upload.single('archivo'),
  [
    body('tipo')
      .isIn(['receta_medica', 'certificado_antecedentes', 'cedula_identidad', 'otro'])
      .withMessage('Tipo de documento inválido'),
    body('nombre').notEmpty().withMessage('Nombre del documento es requerido'),
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    try {
      const patient = await Patient.findById(req.params.id);
      if (!patient) {
        res.status(404).json({ message: 'Paciente no encontrado.' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ message: 'Archivo es requerido.' });
        return;
      }

      patient.documentos.push({
        tipo: req.body.tipo,
        nombre: req.body.nombre,
        archivo: req.file.path,
        fechaSubida: new Date(),
        fechaVencimiento: req.body.fechaVencimiento ? new Date(req.body.fechaVencimiento) : undefined,
        estado: 'pendiente',
        observaciones: req.body.observaciones,
      });

      await patient.save();
      res.status(201).json(patient);
    } catch (error) {
      console.error('Upload document error:', error);
      res.status(500).json({ message: 'Error al subir documento.' });
    }
  }
);

export default router;
