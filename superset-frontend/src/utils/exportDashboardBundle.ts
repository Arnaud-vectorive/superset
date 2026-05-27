/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import domToPdf from 'dom-to-pdf';
import JSZip from 'jszip';
import { kebabCase } from 'lodash';
import {
  logging,
  SupersetClient,
  VizType,
  type QueryFormData,
} from '@superset-ui/core';
import { buildV1ChartDataPayload } from 'src/explore/exploreUtils';
import type { ChartState } from 'src/explore/types';
import type { Slice } from 'src/dashboard/types';

const TABLE_VIZ_TYPES = new Set<string>([
  VizType.Table,
  VizType.PivotTable,
]);

const generateFileStem = (description: string, date = new Date()): string =>
  `${kebabCase(description)}-${date.toISOString().replace(/[: ]/g, '-')}`;

const safeFileName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 120) || 'chart';

/**
 * Render the DOM tree to a PDF blob.
 *
 * Mirrors downloadAsPdf's options. dom-to-pdf always calls pdf.save() at the
 * end, so we intercept the jsPDF instance via the callback to extract the
 * blob and neutralise save() (otherwise the file would be downloaded twice:
 * once as a loose PDF, once again from inside the zip).
 */
const generatePdfBlob = (
  selector: string,
  description: string,
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (!element) {
      reject(new Error('Dashboard element not found'));
      return;
    }

    const gridContent = (element as Element).querySelector(
      '.grid-content',
    ) as HTMLElement | null;
    const contentWidth = gridContent ? gridContent.scrollWidth + 32 : undefined;

    const overrideStyle = document.createElement('style');
    overrideStyle.setAttribute('data-pdf-export-override', '');
    overrideStyle.innerHTML = `
      .dashboard-content,
      .dashboard,
      .grid-container,
      .dashboard-grid,
      .grid-content {
        background-color: #ffffff !important;
        background-image: none !important;
      }
      * {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      *::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
    `;
    document.head.appendChild(overrideStyle);

    const cleanup = () => {
      if (overrideStyle.parentNode) {
        overrideStyle.parentNode.removeChild(overrideStyle);
      }
    };

    const options = {
      margin: 10,
      filename: `${generateFileStem(description)}.pdf`,
      image: { type: 'jpeg', quality: 0.9 },
      html2canvas: { scale: 2 },
      ...(contentWidth ? { overrideWidth: contentWidth } : {}),
      excludeClassNames: ['header-controls'],
    };

    let captured: Blob | null = null;
    const capturePdf = (pdf: any) => {
      if (!pdf) return;
      try {
        captured = pdf.output('blob') as Blob;
        // suppress dom-to-pdf's automatic pdf.save(filename) call that
        // follows this callback
        // eslint-disable-next-line no-param-reassign
        pdf.save = () => undefined;
      } catch (e) {
        logging.error('Failed to capture PDF blob', e);
      }
    };

    domToPdf(element, options, capturePdf)
      .then(() => {
        cleanup();
        if (captured) resolve(captured);
        else reject(new Error('PDF generation produced no blob'));
      })
      .catch((e: Error) => {
        cleanup();
        reject(e);
      });
  });

const isTableChart = (chartState: ChartState | undefined): boolean => {
  const vizType = (chartState?.latestQueryFormData as { viz_type?: string })
    ?.viz_type;
  return !!vizType && TABLE_VIZ_TYPES.has(vizType);
};

interface FetchXlsxResult {
  filename: string;
  blob: Blob;
}

const fetchChartXlsx = async (
  chartState: ChartState,
  slice: Slice | undefined,
): Promise<FetchXlsxResult | null> => {
  const formData = chartState.latestQueryFormData as QueryFormData | undefined;
  if (!formData) return null;
  // always request the raw query result ('full'). The pivoted output
  // ('post_processed') has a server-side bug on some datasets
  // (`can only concatenate str (not "float") to str`) and would crash the
  // export for the whole dashboard
  const payload = await buildV1ChartDataPayload({
    formData,
    force: false,
    resultFormat: 'xlsx',
    resultType: 'full',
    ownState: {},
  });
  const response = await SupersetClient.post({
    endpoint: '/api/v1/chart/data',
    jsonPayload: payload,
    parseMethod: 'raw',
  });
  const blob = await (response as any).blob();
  const baseName =
    slice?.slice_name ||
    (formData as { slice_name?: string }).slice_name ||
    `chart_${chartState.id}`;
  return {
    filename: `${safeFileName(baseName)}.xlsx`,
    blob,
  };
};

export interface ExportDashboardBundleParams {
  selector: string;
  dashboardTitle: string;
  charts: Record<string, ChartState>;
  slices: Record<number, Slice>;
}

/**
 * Generate a zip bundle containing the dashboard PDF and one XLSX per
 * table-type chart, then trigger a single browser download.
 */
export const exportDashboardBundle = async ({
  selector,
  dashboardTitle,
  charts,
  slices,
}: ExportDashboardBundleParams): Promise<void> => {
  const stem = generateFileStem(dashboardTitle || 'dashboard');
  const zip = new JSZip();

  const tableCharts = Object.values(charts).filter(isTableChart);
  // run PDF generation and XLSX fetches in parallel — html2canvas is CPU-bound
  // while XLSX requests are network-bound, so wall time ≈ max instead of sum
  const [pdfBlob, xlsxResults] = await Promise.all([
    generatePdfBlob(selector, dashboardTitle),
    Promise.all(
      tableCharts.map(async chart => {
        try {
          return await fetchChartXlsx(chart, slices[chart.id]);
        } catch (e) {
          logging.error(`XLSX export failed for chart ${chart.id}`, e);
          return null;
        }
      }),
    ),
  ]);

  zip.file(`${stem}.pdf`, pdfBlob);

  const usedNames = new Set<string>();
  xlsxResults.forEach(result => {
    if (!result) return;
    let { filename } = result;
    // de-duplicate when two tables share the same slice_name
    let suffix = 2;
    const base = filename.replace(/\.xlsx$/, '');
    while (usedNames.has(filename)) {
      filename = `${base}-${suffix}.xlsx`;
      suffix += 1;
    }
    usedNames.add(filename);
    zip.folder('tables')?.file(filename, result.blob);
  });

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    // level 1 = fastest DEFLATE; PDF and XLSX are already compressed
    // internally, so a higher level barely changes the final size
    compressionOptions: { level: 1 },
  });

  const url = window.URL.createObjectURL(zipBlob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}.zip`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    window.URL.revokeObjectURL(url);
  }
};
