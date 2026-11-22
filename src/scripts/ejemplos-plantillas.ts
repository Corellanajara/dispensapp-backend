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
    paciente_nombre: 'Christian Díaz',
    paciente_rut: '13.241.708-3',
    paciente_email: 'corellanajara@hotmail.com',
    dispensario_nombre: 'Sucursal text',
    dispensario_direccion: 'Av. Ejemplo 123, SSSSS, SANTIAGO',
    dispensario_ciudad: 'Santiago',
  };
  for (const tipo of TIPOS_GENERADOS) {
    const p = PLANTILLAS_POR_DEFECTO[tipo];
    const pdf = await generarPdf({ titulo: p.titulo, contenido: p.contenido, datos, version: 0 });
    const archivo = path.join(carpeta, `${tipo.replace('_', '-')}-ejemplo.pdf`);
    fs.writeFileSync(archivo, pdf.buffer);
    console.log(`${archivo}  (${pdf.paginas} página(s), firma en página ${pdf.posicionFirma.pagina})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
