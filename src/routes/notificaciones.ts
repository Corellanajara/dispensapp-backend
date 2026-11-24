import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Notificacion } from '../models/Notificacion';

/** Avisos dentro de la app del usuario conectado (paciente o personal). */
const router = Router();

// GET /api/notificaciones — últimos avisos y cuántos faltan por leer
router.get('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const destinatario = req.user!._id;
    const [items, noLeidas] = await Promise.all([
      Notificacion.find({ destinatario }).sort({ createdAt: -1 }).limit(30).select('-destinatario'),
      Notificacion.countDocuments({ destinatario, leida: false }),
    ]);
    res.json({ items, noLeidas });
  } catch (error) {
    console.error('Get notificaciones error:', error);
    res.status(500).json({ message: 'Error al obtener los avisos.' });
  }
});

// POST /api/notificaciones/leer-todas
router.post('/leer-todas', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await Notificacion.updateMany({ destinatario: req.user!._id, leida: false }, { leida: true, fechaLectura: new Date() });
    res.json({ noLeidas: 0 });
  } catch (error) {
    console.error('Read all notificaciones error:', error);
    res.status(500).json({ message: 'Error al marcar los avisos.' });
  }
});

// POST /api/notificaciones/:id/leer
router.post('/:id/leer', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      res.status(400).json({ message: 'Aviso inválido.' });
      return;
    }
    await Notificacion.updateOne(
      { _id: req.params.id, destinatario: req.user!._id, leida: false },
      { leida: true, fechaLectura: new Date() }
    );
    const noLeidas = await Notificacion.countDocuments({ destinatario: req.user!._id, leida: false });
    res.json({ noLeidas });
  } catch (error) {
    console.error('Read notificacion error:', error);
    res.status(500).json({ message: 'Error al marcar el aviso.' });
  }
});

export default router;
