import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { Product } from '../models/Product';
import { resolveDownloadToken, UPLOAD_ROOT } from '../services/storage';

/**
 * Descarga de archivos.
 * - /api/files/descarga/:token — documento privado con enlace temporal (lo entrega una ruta con permisos).
 * - /uploads/:archivo — imágenes de productos antiguas. Solo se sirven si son la imagen de un producto.
 */
const router = Router();

router.get('/descarga/:token', (req: Request, res: Response): void => {
  const abs = resolveDownloadToken(String(req.params.token));
  if (!abs) {
    res.status(404).json({ message: 'El enlace venció o no es válido. Vuelve a abrir el documento.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(abs);
});

export default router;

/**
 * Archivos antiguos en la raíz de /uploads. Antes todo se servía público;
 * ahora solo se entregan si son la imagen de un producto. Los documentos se piden por su ruta con permisos.
 */
export async function legacyProductImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const nombre = path.basename(String(req.params.archivo));
    const ref = `/uploads/${nombre}`;
    const esImagen = await Product.exists({ imagen: ref });
    const abs = path.join(UPLOAD_ROOT, nombre);
    if (!esImagen || !fs.existsSync(abs)) {
      res.status(404).end();
      return;
    }
    res.sendFile(abs);
  } catch (err) {
    next(err);
  }
}
