pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

function waitForPDFjs(callback) {
  if (typeof pdfjsLib !== 'undefined') {
    console.log('[init] PDF.js cargado correctamente');
    callback();
  } else {
    console.warn('[init] Esperando que PDF.js esté disponible...');
    setTimeout(() => waitForPDFjs(callback), 100);
  }
}

class FakeLinkService {
  constructor() {
    this._document = null;
  }
  setDocument(doc) { this._document = doc; }
  getDestinationHash(dest) { return typeof dest === 'string' ? `#${escape(dest)}` : ''; }
  getAnchorUrl(dest) { return this.getDestinationHash(dest); }
  addLinkAttributes() {}
}

const url = 'pdfs/test.pdf';
let pdfDoc = null;
let currentPage = 1;
let renderTask = null;
let isRendering = false;
const canvas = document.getElementById('pdf-render');
const ctx = canvas.getContext('2d');
let annotationCanvas = null;
let drawingEnabled = false;
let annotationCache = loadCacheFromStorage();
let formFieldsCache = loadFormFieldsFromStorage();
const historyStack = {};
let currentLineWidth = 3;

window.onload = () => {
  waitForPDFjs(() => {
    createWatermarkOverlay();
  });
};

function createWatermarkOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'watermark';
  Object.assign(overlay.style, {
    position: 'absolute',
    top: '35px',
    left: '575px',
    color: 'rgba(0,0,0,0.2)',
    fontSize: '16px',
    fontWeight: 'bold',
    zIndex: '9999',
    pointerEvents: 'none',
    userSelect: 'none'
  });
  document.body.appendChild(overlay);

  function updateWatermark() {
    const now = new Date().toLocaleString();
    const userId = localStorage.getItem('studentCode') || 'Sin código';
    overlay.textContent = `${userId} • ${now}`;
  }

  setInterval(updateWatermark, 5000);
  updateWatermark();
}

function loadPDF() {
  console.log('[loadPDF] Iniciando carga del PDF...');
  pdfjsLib.getDocument(url).promise.then(doc => {
    console.log('[loadPDF] PDF cargado correctamente, páginas:', doc.numPages);
    pdfDoc = doc;
    detectFormFields(pdfDoc);
    document.getElementById('user-section').style.display = 'none';
    const pdfControls = document.getElementById('pdf-controls');
    if (pdfControls) pdfControls.style.display = 'flex';
    renderPage(currentPage);
  }).catch(err => {
    console.error('[loadPDF] Error al cargar el PDF:', err);
    alert('No se pudo cargar el PDF. Por favor, intenta de nuevo.');
  });
}

function detectFormFields(pdfDoc) {
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    pdfDoc.getPage(i).then(page =>
      page.getAnnotations().then(annotations => {
        const widgets = annotations.filter(a => a.subtype === 'Widget');
        if (widgets.length === 0) {
          console.warn(`[Campos][Pág ${i}] No se detectaron campos rellenables`);
        } else {
          widgets.forEach(field => {
            console.log(`[Campo][Pág ${i}] Nombre: ${field.fieldName} | Tipo: ${field.fieldType} | Valor: ${field.fieldValue || 'Sin valor'}`);
          });
        }
      })
    );
  }
}

async function renderPage(num) {
  if (renderTask) {
    renderTask.cancel();
    await renderTask.promise.catch(() => {});
  }

  isRendering = true;

  const container = document.getElementById('pdf-container');
  const pageInfo = document.getElementById('page-info');
  const page = await pdfDoc.getPage(num);
  const scale = 1.0;
  const viewport = page.getViewport({ scale });

  await syncLoadFromBackend(num);

  canvas.width = 595;
  canvas.height = 842;
  canvas.style.width = '595px';
  canvas.style.height = '842px';

  clearAnnotations();
  container.innerHTML = '';
  container.style.position = 'relative';
  container.appendChild(canvas);

  const annotationLayerDiv = document.createElement('div');
  annotationLayerDiv.className = 'annotationLayer';
  Object.assign(annotationLayerDiv.style, {
    position: 'absolute',
    top: '0px',
    left: '0px',
    width: '595px',
    height: '842px',
    transform: 'none',
    transformOrigin: 'top left',
    zIndex: 2,
    pointerEvents: 'auto'
  });
  container.appendChild(annotationLayerDiv);

  annotationCanvas = createAnnotationCanvas(num, 595, 842);
  Object.assign(annotationCanvas.style, {
    position: 'absolute',
    top: '0px',
    left: '0px',
    zIndex: 3,
    pointerEvents: drawingEnabled ? 'auto' : 'none'
  });
  container.appendChild(annotationCanvas);
  loadAnnotation(num, annotationCanvas);

  renderTask = page.render({ canvasContext: ctx, viewport });
  await renderTask.promise;

  const annotations = await page.getAnnotations({ intent: 'display' });

  annotations.forEach(annotation => {
    if (annotation.fieldType !== 'Tx') return;

    const [x1, y1, x2, y2] = annotation.rect;
    const width = x2 - x1;
    const height = y2 - y1;
    const top = viewport.height - y2;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "textWidgetAnnotation";
    input.name = annotation.fieldName;
    input.value = formFieldsCache[num]?.[annotation.fieldName] || annotation.fieldValue || "";

    Object.assign(input.style, {
      position: "absolute",
      left: `${x1}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`
    });

    input.addEventListener('input', () => {
      if (!formFieldsCache[num]) formFieldsCache[num] = {};
      formFieldsCache[num][annotation.fieldName] = input.value;
      localStorage.setItem('autra_form_fields', JSON.stringify(formFieldsCache));
      syncSaveToBackend(num);
    });

    annotationLayerDiv.appendChild(input);
  });

  requestAnimationFrame(() => {
    const removeTransformRecursively = el => {
      el.style.transform = 'none';
      el.style.transformOrigin = 'top left';
      for (const child of el.children) {
        removeTransformRecursively(child);
      }
    };
    removeTransformRecursively(annotationLayerDiv);
  });

  if (pageInfo) pageInfo.textContent = `Página ${num} de ${pdfDoc.numPages}`;
  isRendering = false;
}

function clearAnnotations() {
  document.querySelectorAll('.annotationLayer, .annotationCanvas').forEach(el => el.remove());
}

function loadCacheFromStorage() {
  try {
    return JSON.parse(localStorage.getItem('autra_annotations')) || {};
  } catch { return {}; }
}

function loadFormFieldsFromStorage() {
  try {
    return JSON.parse(localStorage.getItem('autra_form_fields')) || {};
  } catch { return {}; }
}

function createAnnotationCanvas(pageNumber, width, height) {
  const canvas = document.createElement('canvas');
  canvas.className = 'annotationCanvas';
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.lineWidth = currentLineWidth;
  ctx.strokeStyle = 'red';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let drawing = false;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX || e.touches?.[0]?.clientX) - rect.left,
      y: (e.clientY || e.touches?.[0]?.clientY) - rect.top
    };
  }

  function start(e) {
    if (!drawingEnabled) return;
    const { x, y } = getPos(e);
    drawing = true;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function draw(e) {
    if (!drawing) return;
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function stop() {
    if (!drawing) return;
    drawing = false;
    saveAnnotation(pageNumber, canvas);
  }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stop);
  canvas.addEventListener('mouseleave', stop);
  canvas.addEventListener('touchstart', start);
  canvas.addEventListener('touchmove', draw);
  canvas.addEventListener('touchend', stop);

  return canvas;
}

function saveAnnotation(pageNumber, canvas) {
  const dataURL = canvas.toDataURL();
  annotationCache[pageNumber] = dataURL;

  if (!historyStack[pageNumber]) historyStack[pageNumber] = [];
  historyStack[pageNumber].push(dataURL);

  localStorage.setItem('autra_annotations', JSON.stringify(annotationCache));
  syncSaveToBackend(pageNumber);
}

function loadAnnotation(pageNumber, canvas) {
  const data = annotationCache[pageNumber];
  if (!data) return;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0);
  img.src = data;
}

function toggleDrawingMode() {
  drawingEnabled = !drawingEnabled;
  const btn = document.getElementById('toggle-draw-btn');
  if (btn) {
    btn.style.background = drawingEnabled ? '#F9EEE0' : 'var(--primary-gradient)';
    btn.style.color = drawingEnabled ? '#545454' : '#FFFFFF';
  }
  if (annotationCanvas) {
    annotationCanvas.style.pointerEvents = drawingEnabled ? 'auto' : 'none';
  }
}

function toggleColorPicker() {
  const colorPicker = document.getElementById('color-picker');
  const sizePicker = document.getElementById('size-picker');
  colorPicker.style.display = colorPicker.style.display === 'none' ? 'block' : 'none';
  if (sizePicker.style.display === 'block') sizePicker.style.display = 'none';
}

function setColor(color) {
  if (annotationCanvas) {
    annotationCanvas.getContext('2d').strokeStyle = color;
    document.getElementById('color-picker-btn').style.border = `2px solid ${color}`;
  }
}

function toggleSizePicker() {
  const sizePicker = document.getElementById('size-picker');
  const colorPicker = document.getElementById('color-picker');
  sizePicker.style.display = sizePicker.style.display === 'none' ? 'block' : 'none';
  if (colorPicker.style.display === 'block') colorPicker.style.display = 'none';
}

function setLineWidth(value) {
  currentLineWidth = parseInt(value);
  if (annotationCanvas) {
    annotationCanvas.getContext('2d').lineWidth = currentLineWidth;
  }
  const sizeBtn = document.getElementById('size-picker-btn');
  sizeBtn.style.borderWidth = `${Math.min(currentLineWidth / 2, 2)}px`;
  sizeBtn.style.borderColor = '#545454';
}

function clearCanvas() {
  if (annotationCanvas) {
    const ctx = annotationCanvas.getContext('2d');
    ctx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    saveAnnotation(currentPage, annotationCanvas);
  }
}

function undoCanvas() {
  const history = historyStack[currentPage];
  if (history && history.length > 1) {
    history.pop();
    const img = new Image();
    img.onload = () => {
      const ctx = annotationCanvas.getContext('2d');
      ctx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
      ctx.drawImage(img, 0, 0);
      annotationCache[currentPage] = history[history.length - 1];
      localStorage.setItem('autra_annotations', JSON.stringify(annotationCache));
    };
    img.src = history[history.length - 1];
  }
}

function goToPage() {
  const pageInput = document.getElementById('goToPageInput');
  const num = parseInt(pageInput.value);
  if (num >= 1 && num <= pdfDoc.numPages) {
    currentPage = num;
    renderPage(currentPage);
    pageInput.value = '';
  } else {
    alert('Página inválida');
  }
}

function downloadAnnotatedPDF() {
  const mergedCanvas = document.createElement('canvas');
  mergedCanvas.width = canvas.width;
  mergedCanvas.height = canvas.height;

  const ctxMerged = mergedCanvas.getContext('2d');
  ctxMerged.drawImage(canvas, 0, 0);

  if (annotationCanvas) {
    ctxMerged.drawImage(annotationCanvas, 0, 0);
  }

  const inputs = document.querySelectorAll('.textWidgetAnnotation');
  ctxMerged.font = '14px Inter, sans-serif';
  ctxMerged.fillStyle = 'black';
  inputs.forEach(input => {
    const left = parseFloat(input.style.left);
    const top = parseFloat(input.style.top);
    const height = parseFloat(input.style.height);
    const value = input.value || '';
    ctxMerged.fillText(value, left, top + height - 4);
  });

  const userId = localStorage.getItem('studentCode') || 'Sin código';
  const now = new Date().toLocaleString();
  ctxMerged.font = '16px Inter, sans-serif';
  ctxMerged.fillStyle = 'rgba(0,0,0,0.2)';
  ctxMerged.fillText(`${userId} • ${now}`, 10, 26);

  mergedCanvas.toBlob(blob => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `test_pagina_${currentPage}.png`;
    link.click();
  }, 'image/png');
}

const resizeObserver = new ResizeObserver(() => {
  if (!pdfDoc) return;
  if (isRendering) return;
  renderPage(currentPage);
});
resizeObserver.observe(document.getElementById('pdf-container'));

function nextPage() {
  if (currentPage >= pdfDoc.numPages) return;
  currentPage++;
  renderPage(currentPage);
}

function prevPage() {
  if (currentPage <= 1) return;
  currentPage--;
  renderPage(currentPage);
}

async function syncSaveToBackend(pageNumber) {
  const studentCode = localStorage.getItem('studentCode');
  if (!studentCode) return;
  const formFields = formFieldsCache[pageNumber] || {};
  const annotationData = annotationCache[pageNumber] || null;

  try {
    const response = await fetch('https://autra-backend.onrender.com/api/save-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentCode,
        page: pageNumber,
        formFields,
        annotation: annotationData
      })
    });
    const data = await response.json();
    if (!data.success) {
      console.warn('[syncSave] Error en respuesta del servidor:', data.message);
    } else {
      console.log(`[syncSave] Página ${pageNumber} sincronizada con éxito.`);
    }
  } catch (err) {
    console.error('[syncSave] Fallo al sincronizar con backend:', err);
  }
}

async function syncLoadFromBackend(pageNumber) {
  const studentCode = localStorage.getItem('studentCode');
  if (!studentCode) return;

  try {
    const response = await fetch(`https://autra-backend.onrender.com/api/load-page?studentCode=${studentCode}&page=${pageNumber}`);
    const data = await response.json();
    if (data.success) {
      formFieldsCache[pageNumber] = data.formFields || {};
      localStorage.setItem('autra_form_fields', JSON.stringify(formFieldsCache));
      if (data.annotation) {
        annotationCache[pageNumber] = data.annotation;
        localStorage.setItem('autra_annotations', JSON.stringify(annotationCache));
      }
      console.log(`[syncLoad] Página ${pageNumber} recuperada del backend.`);
    } else {
      console.warn('[syncLoad] No hay datos remotos para esta página.');
    }
  } catch (err) {
    console.error('[syncLoad] Error al recuperar datos del backend:', err);
  }
}
