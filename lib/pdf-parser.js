/**
 * PDF 文本提取器（基于 Mozilla PDF.js）
 * 支持：中文、嵌入字体、复杂布局、扫描版检测
 */

export async function extractTextFromPDF(arrayBuffer) {
  // 使用全局 pdfjsLib（由 options.html 中的 <script src="lib/pdf.min.js"> 加载）
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    throw new Error('PDF.js 未加载，请刷新页面重试');
  }

  // 设置 worker 路径（指向扩展内的本地文件）
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;

  const pageTexts = [];
  let totalChars = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    // 按坐标排序后还原阅读顺序
    const items = textContent.items.filter(item => item.str && item.str.trim());

    items.sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5];
      if (Math.abs(yDiff) > 5) return yDiff; // 不同行：Y 从大到小（从上到下）
      return a.transform[4] - b.transform[4]; // 同行：X 从小到大（从左到右）
    });

    let prevY = null;
    const lines = [];
    let currentLine = [];

    for (const item of items) {
      const y = item.transform[5];
      if (prevY !== null && Math.abs(y - prevY) > 5) {
        if (currentLine.length > 0) {
          lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
          currentLine = [];
        }
      }
      currentLine.push(item.str);
      prevY = y;
    }
    if (currentLine.length > 0) {
      lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
    }

    const pageText = lines.filter(l => l.length > 0).join('\n');
    if (pageText.trim()) {
      pageTexts.push(pageText);
      totalChars += pageText.length;
    }
  }

  const fullText = pageTexts.join('\n\n');

  // 如果提取到的可读字符极少，可能是扫描版 PDF
  if (totalChars < 50) {
    throw new Error('SCAN_PDF');
  }

  return fullText;
}
