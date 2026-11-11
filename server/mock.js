// Demo answers used when AI_MOCK=1: lets you try every screen (and run the tests) without an API key.
// The shapes match what server/ai.js returns from Claude.
const usage = { input_tokens: 0, output_tokens: 0 };
const pausa = ms => new Promise(r => setTimeout(r, ms));

export async function guion({ tipo, brief = {} }) {
  await pausa(400);
  const n = brief.nombre || 'tu producto';
  const base = tipo === 'lugar'
    ? [['Gancho', 'El plano más espectacular del lugar', `Tres razones para no perderte ${n}.`, 'titulo', n], ['La llegada', 'Tú caminando hacia la entrada', 'Llegar ya es parte del plan.', 'none', ''], ['Lo mejor', 'Plano amplio y un detalle', `${brief.p1 || 'Las vistas'}: esto no sale igual en fotos.`, 'ficha', brief.p1 || 'Las vistas'], ['Mi consejo', 'El cartel de horarios', brief.dato || 'Ven temprano y con calma.', 'none', ''], ['Veredicto', 'Tú mirando a cámara', `${brief.veredicto || 'Vale la pena.'} ${brief.cta || ''}`.trim(), 'cta', brief.cta || 'Guárdalo']]
    : [['Gancho', 'El producto ya puesto, de cerca', `Esto es lo que nadie te cuenta de ${n}.`, 'titulo', n], ['Vuelta atrás', 'La caja cerrada sobre la mesa', 'Pero empecemos por el principio.', 'none', ''], ['Apertura', 'Tus manos abriendo la caja', 'Mira cómo viene.', 'none', ''], ['El detalle', 'Primer plano del detalle', `${brief.p1 || 'El acabado'}: aquí se nota la calidad.`, 'ficha', brief.p1 || 'El acabado'], ['Veredicto', 'Tú mirando a cámara', `${brief.veredicto || 'Me lo quedo.'} ${brief.cta || ''}`.trim(), 'cta', brief.cta || 'Enlace en bio']];
  return { data: { escenas: base.map(([nombre, toma, frase, rotulo_tipo, rotulo_texto]) => ({ nombre, toma, frase, rotulo_tipo, rotulo_texto })) }, usage };
}

export async function montaje({ tomas, dur }) {
  await pausa(600);
  const planos = []; let t = 0, i = 0;
  while (t < dur && i < 30) {
    const tm = tomas[i % tomas.length], d = tm.tipo === 'foto' ? 2.5 : Math.min(3, Math.max(1.2, (tm.duracion_s || 3) / 2));
    const ini = tm.tipo === 'foto' ? 0 : Math.min(Math.max(0, (tm.duracion_s || 3) - d), (Math.floor(i / tomas.length) * d));
    planos.push({ toma: tm.id, inicio: +ini.toFixed(2), fin: +(ini + d).toFixed(2), nombre: i === 0 ? 'Gancho' : `Plano ${i + 1}`, sonido: 'ambiente', rotulo_tipo: i === 0 ? 'titulo' : 'none', rotulo_texto: i === 0 ? 'Demo' : '' });
    t += d; i++;
  }
  return { data: { planos }, usage };
}

export async function extractos({ dur, cuantos, min, max }) {
  await pausa(800);
  const n = Math.max(1, Math.min(cuantos, Math.floor(dur / (max + 2)) || 1)), paso = dur / n, lista = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, paso * i + paso * 0.3), largo = Math.min(max, Math.max(min, (min + max) / 2));
    lista.push({ inicio: +a.toFixed(2), fin: +Math.min(dur, a + largo).toFixed(2), titulo: `Momento ${i + 1}`, gancho: ['Mira esto', 'No te lo pierdas', 'El detalle clave', 'Mi favorito', 'Vale la pena', 'Ojo con esto'][i % 6], motivo: 'Respuesta de demostración: aquí Claude explica por qué este momento funciona.', puntuacion: 92 - i * 6, descripcion: 'Texto de demostración para publicar este clip. Guárdalo para tu próximo viaje. #demo #estudio #video' });
  }
  return { data: { resumen: 'Modo demostración: momentos repartidos a lo largo del video.', extractos: lista }, usage };
}

export async function afinar({ clips }) {
  await pausa(300);
  return { data: { clips: clips.map(c => ({ id: c.id, inicio: +(c.inicio + 0.2).toFixed(2), fin: +(c.fin - 0.1).toFixed(2) })) }, usage };
}

export async function editar({ proyecto, mensaje }) {
  await pausa(400);
  const es = proyecto?.escenas || [], m = mensaje.toLowerCase(), ops = [];
  let texto = 'Modo demostración: entiendo «quita», «sube», «subtítulos», «4:5» y «título». Con una clave de Claude podrás pedir cualquier cambio.';
  const quita = /quita(?:r)? la (?:escena )?(\d+)/.exec(m), sube = /sube la (?:escena )?(\d+)/.exec(m), tit = /t[ií]tulo (?:por|a|:)\s*(.+)$/.exec(mensaje);
  if (quita && es[+quita[1] - 1]) { ops.push({ op: 'quitar', id: es[+quita[1] - 1].id, campo: '', valor: '', pos: 0 }); texto = `Quité la escena ${quita[1]}.`; }
  else if (sube && es[+sube[1] - 1]) { ops.push({ op: 'mover', id: es[+sube[1] - 1].id, campo: '', valor: '', pos: Math.max(1, +sube[1] - 1) }); texto = `Subí la escena ${sube[1]} un puesto.`; }
  else if (/subt/.test(m)) { const no = /sin|quita|no /.test(m); ops.push({ op: 'ajuste', id: '', campo: 'subtitulos', valor: no ? 'no' : 'si', pos: 0 }); texto = no ? 'Quité los subtítulos.' : 'Activé los subtítulos.'; }
  else if (/4[:x]5/.test(m)) { ops.push({ op: 'ajuste', id: '', campo: 'formato', valor: '4x5', pos: 0 }); texto = 'Cambié el formato a 4:5.'; }
  else if (tit && es[0]) { ops.push({ op: 'cambiar', id: es[0].id, campo: 'rotulo_tipo', valor: 'titulo', pos: 0 }, { op: 'cambiar', id: es[0].id, campo: 'rotulo_texto', valor: tit[1].trim(), pos: 0 }); texto = `Puse «${tit[1].trim()}» como título.`; }
  return { data: { mensaje: texto, ops }, usage };
}

export async function publicar({ brief = {} }) {
  await pausa(400);
  const n = brief.nombre || 'mi último descubrimiento';
  return { data: { instagram: `${n}: lo abrí y esto es lo que pienso.\n\nTexto de demostración. Con una clave de Claude, aquí aparece tu descripción lista para pegar.\n\n${brief.cta || 'Guárdalo para después.'}`, tiktok: `${n}, sin filtros.`, titulo_corto: `${n}: mi opinión sincera`, hashtags: ['demo', 'unboxing', 'estudiodaniela', 'reels', 'opinionsincera'], portada: n.split(' ').slice(0, 4).join(' '), ganchos: ['Esto no me lo esperaba.', 'Tres cosas antes de comprarlo.', 'Por fin llegó.'] }, usage };
}

export async function transcribir(wav) {
  await pausa(300);
  // 16 kHz mono 16-bit: 32000 bytes per second after the 44-byte header.
  const dur = Math.max(0, (wav.length - 44) / 32000), base = 'esto es una transcripción de demostración para probar los subtítulos del estudio'.split(' '), palabras = [];
  for (let t = 0.5, i = 0; t < dur - 0.5; t += 0.45, i++) { if (i % 9 === 8) { t += 1.2; continue; } palabras.push({ t: base[i % base.length], a: +t.toFixed(2), b: +(t + 0.38).toFixed(2) }); }
  return { data: { palabras, idioma: 'es' }, usage: null };
}
