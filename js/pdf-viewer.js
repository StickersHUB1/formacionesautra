// js/pdf-viewer.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

// Configuración global
const FIELD_OFFSET_Y = 7.5; // Ajuste para campos rellenables
const TEXT_RENDER_OFFSET = 0; // Ajuste para texto en PNG
const DEFAULT_WIDTH = 595; // A4 width en px (según styles.css)
const DEFAULT_HEIGHT = 842; // A4 height en px (según styles.css)

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
  setDocument(doc) {
    this._document = doc;
  }
  getDestinationHash(dest) {
    return typeof dest === 'string' ? `#${escape(dest)}` : '';
  }
  getAnchorUrl(dest) {
    return this.getDestinationHash(dest);
  }
  addLinkAttributes() {}
}

const url = 'pdfs/test.pdf'; // Ajusta esta ruta si es necesario
let pdfDoc = null;
let currentPage = 1;
let renderTask = null;
let isRendering = false;
const canvas = document.getElementById('pdf-render');
const ctx = canvas.getContext('2d');
let annotationCanvas = null;
let activeTool = 'none'; // 'draw', 'highlight', 'none' (eliminé 'note')
let annotationCache = loadCacheFromStorage();
let formFieldsCache = loadFormFieldsFromStorage();
let highlightsCache = loadHighlightsFromStorage();
let currentLineWidth = 3;
let currentColor = 'red';
let undoHistory = [];

// Funciones globales
window.loadPDF = loadPDF;
window.nextPage = nextPage;
window.prevPage = prevPage;
window.goToPage = goToPage;
window.logout = logout;
window.toggleDrawingMode = toggleDrawingMode;
// Eliminé toggleNoteMode
window.toggleHighlightMode = toggleHighlightMode;
window.toggleThumbnails = toggleThumbnails;

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
  console.log('[loadPDF] Iniciando carga del PDF desde:', url);
  pdfjsLib.getDocument(url).promise.then(doc => {
    console.log('[loadPDF] PDF cargado correctamente, páginas:', doc.numPages);
    pdfDoc = doc;
    detectFormFieldsForPage(currentPage);
    document.getElementById('user-section').style.display = 'none';
    const pdfControls = document.getElementById('pdf-controls');
    if (pdfControls) {
      pdfControls.style.display = 'flex';
    }
    renderPage(currentPage);
  }).catch(err => {
    console.error('[loadPDF] Error al cargar el PDF:', err);
    alert('No se pudo cargar el PDF. Verifica la ruta o el archivo.');
  });
}

async function detectFormFieldsForPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const annotations = await page.getAnnotations();
  const widgets = annotations.filter(a => a.subtype === 'Widget' && a.fieldType === 'Tx');

  if (widgets.length === 0) {
    console.warn(`[Campos][Pág ${pageNum}] No se detectaron campos rellenables`);
  } else {
    widgets.forEach(field => {
      const alignment = field.textAlignment !== undefined 
        ? ['left', 'center', 'right'][field.textAlignment] || 'left' 
        : 'left';
      const fontInfo = field.font || {};
      console.log(`[Campo][Pág ${pageNum}] Nombre: ${field.fieldName} | Tipo: ${field.fieldType} | Valor: ${field.fieldValue || 'Sin valor'} | Alineación: ${alignment} | Fuente: ${fontInfo.fontName || 'Desconocida'}`);
      
      if (!formFieldsCache[pageNum]) formFieldsCache[pageNum] = {};
      formFieldsCache[pageNum][field.fieldName] = {
        value: field.fieldValue || formFieldsCache[pageNum][field.fieldName]?.value || '',
        alignment: alignment,
        font: fontInfo.fontName || 'Arial',
        fontSize: fontInfo.fontSize || 12
      };
    });
    saveFormFieldsCache();
  }
}

function saveFormFieldsCache() {
  try {
    localStorage.setItem('autra_form_fields', JSON.stringify(formFieldsCache));
    console.log('[saveFormFieldsCache] Campos guardados en localStorage:', formFieldsCache);
  } catch (err) {
    console.error('[saveFormFieldsCache] Error al guardar en localStorage:', err);
  }
}

function loadFormFieldsFromStorage() {
  const saved = localStorage.getItem('autra_form_fields');
  if (!saved) {
    console.log('[loadFormFieldsFromStorage] No hay campos guardados en localStorage');
    return {};
  }
  try {
    const parsed = JSON.parse(saved);
    console.log('[loadFormFieldsFromStorage] Campos cargados desde localStorage:', parsed);
    return parsed;
  } catch (err) {
    console.error('[loadFormFieldsFromStorage] Error al parsear localStorage:', err);
    return {};
  }
}

function loadHighlightsFromStorage() {
  const saved = localStorage.getItem('autra_highlights');
  if (!saved) {
    console.log('[loadHighlightsFromStorage] No hay resaltados guardados en localStorage');
    return {};
  }
  try {
    const parsed = JSON.parse(saved);
    console.log('[loadHighlightsFromStorage] Resaltados cargados desde localStorage:', parsed);
    return parsed;
  } catch (err) {
    console.error('[loadHighlightsFromStorage] Error al parsear localStorage:', err);
    return {};
  }
}

function saveHighlightsCache() {
  try {
    localStorage.setItem('autra_highlights', JSON.stringify(highlightsCache));
    console.log('[saveHighlightsCache] Resaltados guardados en localStorage:', highlightsCache);
  } catch (err) {
    console.error('[saveHighlightsCache] Error al guardar en localStorage:', err);
  }
}

function loadCacheFromStorage() {
  const saved = localStorage.getItem('autra_annotations');
  if (!saved) {
    console.log('[loadCacheFromStorage] No hay anotaciones guardadas en localStorage');
    return {};
  }
  try {
    const parsed = JSON.parse(saved);
    console.log('[loadCacheFromStorage] Anotaciones cargadas desde localStorage:', parsed);
    return parsed;
  } catch (err) {
    console.error('[loadCacheFromStorage] Error al parsear localStorage:', err);
    return {};
  }
}

function saveAnnotation(pageNumber, canvas) {
  const dataURL = canvas.toDataURL();
  annotationCache[pageNumber] = dataURL;
  try {
    localStorage.setItem('autra_annotations', JSON.stringify(annotationCache));
    console.log(`[saveAnnotation][Pág ${pageNumber}] Anotación guardada en localStorage`);
  } catch (err) {
    console.error(`[saveAnnotation][Pág ${pageNumber}] Error al guardar en localStorage:`, err);
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
  const scale = 1.0; // Escala inicial, ajustable si es necesario
  const viewport = page.getViewport({ scale });

  console.log('[renderPage] Viewport dimensions:', viewport.width, viewport.height);

  // Ajustar canvas base a las dimensiones de styles.css como base
  canvas.width = DEFAULT_WIDTH; // 595px
  canvas.height = DEFAULT_HEIGHT; // 842px
  canvas.style.width = `${DEFAULT_WIDTH}px`;
  canvas.style.height = `${DEFAULT_HEIGHT}px`;
  canvas.style.position = 'absolute';
  canvas.style.top = '0px';
  canvas.style.left = '0px';
  canvas.style.zIndex = '1';
  console.log('[renderPage] Canvas dimensions set to:', canvas.width, canvas.height);

  // Ajustar escala para encajar el contenido en el canvas fijo
  const scaleX = DEFAULT_WIDTH / viewport.width;
  const scaleY = DEFAULT_HEIGHT / viewport.height;
  const adjustedScale = Math.min(scaleX, scaleY);
  const adjustedViewport = page.getViewport({ scale: adjustedScale });

  clearAnnotations();
  container.innerHTML = '';
  container.style.position = 'relative';
  container.style.overflow = 'hidden'; // Evitar desbordamiento
  container.appendChild(canvas);

  // Capa de resaltados
  const highlightCanvas = document.createElement('canvas');
  highlightCanvas.className = 'highlightCanvas';
  highlightCanvas.width = DEFAULT_WIDTH;
  highlightCanvas.height = DEFAULT_HEIGHT;
  Object.assign(highlightCanvas.style, {
    position: 'absolute',
    top: '0px',
    left: '0px',
    zIndex: '2',
    pointerEvents: 'none'
  });
  container.appendChild(highlightCanvas);
  const ctxHighlight = highlightCanvas.getContext('2d');
  if (highlightsCache[num]) {
    ctxHighlight.fillStyle = 'rgba(255, 255, 0, 0.3)';
    highlightsCache[num].forEach(h => {
      ctxHighlight.fillRect(h.x, h.y, h.width, h.height);
    });
  }

  // Capa de dibujo
  annotationCanvas = createAnnotationCanvas(num, DEFAULT_WIDTH, DEFAULT_HEIGHT);
  annotationCanvas.id = 'annotationCanvas';
  annotationCanvas.className = 'annotationCanvas';
  Object.assign(annotationCanvas.style, {
    position: 'absolute',
    top: '0px',
    left: '0px',
    zIndex: '10',
    pointerEvents: activeTool !== 'none' ? 'auto' : 'none'
  });
  container.appendChild(annotationCanvas);
  console.log('[renderPage] annotationCanvas añadido, z-index:', annotationCanvas.style.zIndex, 'pointerEvents:', annotationCanvas.style.pointerEvents);
  loadAnnotation(num, annotationCanvas);

  // Capa de campos rellenables
  const annotationLayerDiv = document.createElement('div');
  annotationLayerDiv.className = 'annotationLayer';
  Object.assign(annotationLayerDiv.style, {
    position: 'absolute',
    top: '0px',
    left: '0px',
    width: `${DEFAULT_WIDTH}px`,
    height: `${DEFAULT_HEIGHT}px`,
    zIndex: '5',
    pointerEvents: 'auto'
  });
  container.appendChild(annotationLayerDiv);

  // Renderizar el PDF con el viewport ajustado
  renderTask = page.render({
    canvasContext: ctx,
    viewport: adjustedViewport
  });
  await renderTask.promise.then(() => {
    console.log('[renderPage] PDF renderizado correctamente en la página', num);
  }).catch(err => {
    console.error('[renderPage] Error al renderizar el PDF:', err);
  });

  await detectFormFieldsForPage(num);

  const annotations = await page.getAnnotations({ intent: 'display' });

  annotations.forEach(annotation => {
    if (annotation.fieldType !== 'Tx') return;

    const [x1, y1, x2, y2] = annotation.rect;
    const width = x2 - x1;
    const height = y2 - y1;
    const top = adjustedViewport.height - y2 + FIELD_OFFSET_Y; // Ajustar según el viewport escalado

    console.log(`[Campo][Pág ${num}] ${annotation.fieldName} | rect: ${annotation.rect} | CSS: left=${x1}px, top=${top}px`);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "textWidgetAnnotation";
    input.name = annotation.fieldName;
    
    const fieldData = formFieldsCache[num]?.[annotation.fieldName] || {};
    input.value = fieldData.value || annotation.fieldValue || "";

    Object.assign(input.style, {
      position: "absolute",
      left: `${x1}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      textAlign: fieldData.alignment || 'left',
      fontFamily: fieldData.font || 'Arial',
      fontSize: `${fieldData.fontSize || 12}px`,
      boxSizing: 'border-box',
      padding: '2px',
      border: annotation.borderStyle?.width ? `${annotation.borderStyle.width}px solid #000` : '1px solid #000',
      backgroundColor: annotation.backgroundColor || '#f9f9f9',
      zIndex: '5'
    });

    input.addEventListener('input', () => {
      if (!formFieldsCache[num]) formFieldsCache[num] = {};
      formFieldsCache[num][annotation.fieldName] = {
        ...fieldData,
        value: input.value
      };
      saveFormFieldsCache();
    });

    annotationLayerDiv.appendChild(input);
  });

  if (pageInfo) {
    pageInfo.textContent = `Página ${num} / ${pdfDoc.numPages}`;
  } else {
    console.warn('[ERROR] Elemento #page-info no encontrado');
  }
  isRendering = false;
  updateCanvasEvents();
}

function clearAnnotations() {
  document.querySelectorAll('.annotationLayer, .annotationCanvas, .highlightCanvas').forEach(el => el.remove());
}

function createAnnotationCanvas(pageNumber, width, height) {
  const canvas = document.createElement('canvas');
  canvas.id = 'annotationCanvas';
  canvas.className = 'annotationCanvas';
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.lineWidth = currentLineWidth;
  ctx.strokeStyle = currentColor;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let isDrawing = false;
  let startX, startY;
  let paths = [];

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX || e.touches?.[0]?.clientX) - rect.left,
      y: (e.clientY || e.touches?.[0]?.clientY) - rect.top
    };
  }

  function startDrawing(e) {
    e.preventDefault();
    console.log('[startDrawing] Activo, tool:', activeTool, 'isRendering:', isRendering);
    if (activeTool === 'none' || isRendering) return;
    isDrawing = true;
    const pos = getPos(e);
    if (activeTool === 'highlight') {
      startX = pos.x;
      startY = pos.y;
      return;
    }
    if (activeTool === 'draw') {
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      paths = [{ x: pos.x, y: pos.y }];
    }
  }

  function draw(e) {
    e.preventDefault();
    console.log('[draw] Moviendo, tool:', activeTool, 'isDrawing:', isDrawing);
    if (!isDrawing || activeTool === 'none' || isRendering) return;
    const pos = getPos(e);
    if (activeTool === 'highlight') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(255, 255, 0, 0.3)';
      ctx.fillRect(startX, startY, pos.x - startX, pos.y - startY);
      return;
    }
    if (activeTool === 'draw') {
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      paths.push({ x: pos.x, y: pos.y });
    }
  }

  function stopDrawing(e) {
    e.preventDefault();
    console.log('[stopDrawing] Terminado, tool:', activeTool, 'isDrawing:', isDrawing);
    if (!isDrawing || activeTool === 'none' || isRendering) return;
    isDrawing = false;
    if (activeTool === 'highlight') {
      const pos = getPos(e);
      if (!highlightsCache[pageNumber]) highlightsCache[pageNumber] = [];
      const highlight = {
        x: Math.min(startX, pos.x),
        y: Math.min(startY, pos.y),
        width: Math.abs(pos.x - startX),
        height: Math.abs(pos.y - startY)
      };
      highlightsCache[pageNumber].push(highlight);
      saveHighlightsCache();
      undoHistory.push({
        type: 'highlight',
        page: pageNumber,
        action: 'add',
        index: highlightsCache[pageNumber].length - 1,
        highlight
      });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      renderPage(pageNumber);
      return;
    }
    if (activeTool === 'draw') {
      const dataURL = canvas.toDataURL();
      annotationCache[pageNumber] = dataURL;
      saveAnnotation(pageNumber, canvas);
      undoHistory.push({
        type: 'draw',
        page: pageNumber,
        dataURL
      });
    }
  }

  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseleave', stopDrawing);
  canvas.addEventListener('touchstart', startDrawing);
  canvas.addEventListener('touchmove', draw);
  canvas.addEventListener('touchend', stopDrawing);
  console.log('[createAnnotationCanvas] Eventos añadidos a annotationCanvas');

  return canvas;
}

function loadAnnotation(pageNumber, canvas) {
  const data = annotationCache[pageNumber];
  if (!data) return;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0);
  };
  img.src = data;
}

function toggleDrawingMode() {
  activeTool = activeTool === 'draw' ? 'none' : 'draw';
  updateButtonStyles();
  updateCanvasEvents();
}

function toggleHighlightMode() {
  activeTool = activeTool === 'highlight' ? 'none' : 'highlight';
  updateButtonStyles();
  updateCanvasEvents();
}

function updateButtonStyles() {
  const buttons = {
    'toggle-draw-btn': activeTool === 'draw',
    'highlight-btn': activeTool === 'highlight'
  };
  for (const [id, active] of Object.entries(buttons)) {
    const btn = document.getElementById(id);
    btn.classList.toggle('active', active);
  }
}

function updateCanvasEvents() {
  if (annotationCanvas) {
    const ctx = annotationCanvas.getContext('2d');
    ctx.lineWidth = currentLineWidth;
    ctx.strokeStyle = currentColor;
    annotationCanvas.style.pointerEvents = activeTool !== 'none' ? 'auto' : 'none';
    annotationCanvas.style.cursor = activeTool === 'draw' ? 'crosshair' : activeTool === 'highlight' ? 'crosshair' : 'auto';
    console.log('[updateCanvasEvents] pointerEvents:', annotationCanvas.style.pointerEvents, 'cursor:', annotationCanvas.style.cursor);
    loadAnnotation(currentPage, annotationCanvas);
  }
}

function toggleColorPicker() {
  const colorPicker = document.getElementById('color-picker');
  const sizePicker = document.getElementById('size-picker');
  colorPicker.style.display = colorPicker.style.display === 'none' ? 'block' : 'none';
  if (sizePicker.style.display === 'block') sizePicker.style.display = 'none';
}

function setColor(color) {
  currentColor = color;
  if (annotationCanvas) {
    annotationCanvas.getContext('2d').strokeStyle = currentColor;
    const colorPickerBtn = document.getElementById('color-picker-btn');
    if (colorPickerBtn) {
      colorPickerBtn.style.border = `2px solid ${color}`;
    }
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
  if (sizeBtn) {
    sizeBtn.style.borderWidth = `${Math.min(currentLineWidth / 2, 2)}px`;
    sizeBtn.style.borderColor = '#545454';
  }
}

function toggleThumbnails() {
  const modal = document.getElementById('thumbnails-modal');
  modal.style.display = modal.style.display === 'none' ? 'block' : 'none';
  if (modal.style.display === 'block') renderThumbnails();
}

async function renderThumbnails() {
  const container = document.getElementById('thumbnails-container');
  container.innerHTML = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale: 0.2 });
    const canvas = document.createElement('canvas');
    canvas.className = 'thumbnail';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    if (i === currentPage) canvas.classList.add('active');
    canvas.addEventListener('click', () => {
      currentPage = i;
      renderPage(i);
      toggleThumbnails();
    });
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    container.appendChild(canvas);
  }
}

function clearCanvas() {
  if (annotationCanvas) {
    const ctx = annotationCanvas.getContext('2d');
    ctx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
    annotationCache[currentPage] = null;
    saveAnnotation(currentPage, annotationCanvas);
    if (highlightsCache[currentPage]) {
      highlightsCache[currentPage] = [];
      saveHighlightsCache();
    }
    undoHistory.push({
      type: 'clear',
      page: currentPage,
      annotations: annotationCache[currentPage],
      highlights: highlightsCache[currentPage] || []
    });
    renderPage(currentPage);
  }
}

function undoCanvas() {
  if (undoHistory.length === 0) return;
  const action = undoHistory.pop();
  switch (action.type) {
    case 'draw':
      annotationCache[action.page] = undoHistory.filter(a => a.type === 'draw' && a.page === action.page).pop()?.dataURL || null;
      saveAnnotation(action.page, annotationCanvas);
      break;
    case 'highlight':
      if (action.action === 'add') {
        highlightsCache[action.page].splice(action.index, 1);
        saveHighlightsCache();
      }
      break;
    case 'clear':
      annotationCache[action.page] = action.annotations;
      highlightsCache[action.page] = action.highlights;
      saveAnnotation(action.page, annotationCanvas);
      saveHighlightsCache();
      break;
  }
  renderPage(currentPage);
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
  inputs.forEach(input => {
    const left = parseFloat(input.style.left);
    const width = parseFloat(input.style.width);
    const height = parseFloat(input.style.height);
    const top = parseFloat(input.style.top);
    const value = input.value || '';
    const fontSize = parseFloat(input.style.fontSize) || 12;
    const fontFamily = input.style.fontFamily || 'Arial';
    const textAlign = input.style.textAlign || 'left';

    ctxMerged.font = `${fontSize}px ${fontFamily}, sans-serif`;
    ctxMerged.fillStyle = 'black';
    ctxMerged.textAlign = textAlign;
    ctxMerged.textBaseline = 'top';

    let x = left;
    if (textAlign === 'center') {
      x += width / 2;
    } else if (textAlign === 'right') {
      x += width;
    }

    const y = top + FIELD_OFFSET_Y + 2 + TEXT_RENDER_OFFSET;

    ctxMerged.fillText(value, x, y);
  });

  // Renderizar resaltados
  if (highlightsCache[currentPage]) {
    ctxMerged.fillStyle = 'rgba(255, 255, 0, 0.3)';
    highlightsCache[currentPage].forEach(h => {
      ctxMerged.fillRect(h.x, h.y, h.width, h.height);
    });
  }

  const userId = localStorage.getItem('studentCode') || 'Sin código';
  const now = new Date().toLocaleString();
  ctxMerged.font = '16px Arial, sans-serif';
  ctxMerged.fillStyle = 'rgba(0,0,0,0.2)';
  ctxMerged.textAlign = 'left';
  ctxMerged.textBaseline = 'top';
  ctxMerged.fillText(`${userId} • ${now}`, 10, 26);

  mergedCanvas.toBlob(blob => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `test_pagina_${currentPage}.png`;
    link.click();
  }, 'image/png');
}

function nextPage() {
  if (!pdfDoc || currentPage >= pdfDoc.numPages) return;
  currentPage++;
  renderPage(currentPage);
}

function prevPage() {
  if (!pdfDoc || currentPage <= 1) return;
  currentPage--;
  renderPage(currentPage);
}

function goToPage() {
  const input = document.getElementById('goToPageInput');
  const pageNum = parseInt(input.value);
  if (pdfDoc && pageNum >= 1 && pageNum <= pdfDoc.numPages) {
    currentPage = pageNum;
    renderPage(currentPage);
    input.value = ''; // Limpiar input
    console.log(`[goToPage] Navegando a página ${pageNum}`);
  } else {
    console.warn(`[goToPage] Número de página inválido: ${pageNum}`);
  }
}

function logout() {
  console.log('Cerrando sesión');
  localStorage.removeItem('studentCode');
  window.location.href = '/login.html';
}

const resizeObserver = new ResizeObserver(() => {
  if (!pdfDoc) return;
  if (isRendering) {
    console.log('[resizeObserver] Resize ignorado: render en curso');
    return;
  }
  renderPage(currentPage);
});
resizeObserver.observe(document.getElementById('pdf-container'));

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const icon = document.getElementById('sidebar-icon');
  const isHidden = sidebar.classList.contains('hidden');

  if (isHidden) {
    sidebar.classList.remove('hidden');
    icon.classList.remove('fa-eye');
    icon.classList.add('fa-eye-slash');
  } else {
    sidebar.classList.add('hidden');
    icon.classList.remove('fa-eye-slash');
    icon.classList.add('fa-eye');
  }
}
