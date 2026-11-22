/**
 * Genera PDFs de ejemplo del reglamento interno y del contrato con el texto por defecto,
 * sin tocar la base de datos.  Uso: npx tsx src/scripts/ejemplos-plantillas.ts [carpeta]
 */
import fs from 'fs';
import path from 'path';
import { PLANTILLAS_POR_DEFECTO, datosDeEjemplo, generarPdf } from '../services/plantillas';
import { TIPOS_GENERADOS } from '../config/documentos';

async function main() {
  const carpeta = path.resolve(process.argv[2] ?? 'ejemplos-documentos');
  fs.mkdirSync(carpeta, { recursive: true });
  const datos = {
    ...datosDeEjemplo(),
    paciente_nombre: 'Juan Pérez Soto',
    paciente_rut: '11.111.111-1',
    paciente_email: 'paciente@ejemplo.cl',
    dispensario_nombre: 'Dispensario Providencia',
    dispensario_direccion: 'Av. Ejemplo 123, Providencia, Santiago',
    dispensario_ciudad: 'Santiago',
  };
  for (const tipo of TIPOS_GENERADOS) {
    const p = PLANTILLAS_POR_DEFECTO[tipo];
    const pdf = await generarPdf({ titulo: p.titulo, contenido: p.contenido, datos, version: 0 });
    const archivo = path.join(carpeta, `${tipo.replace('_', '-')}-ejemplo.pdf`);
    fs.writeFileSync(archivo, pdf.buffer);
    console.log(`${archivo}  (${pdf.paginas} página(s), firma en página ${pdf.posicionFirma.pagina}, y ${pdf.posicionFirma.y})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
