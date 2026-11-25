import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const DOWNLOAD_COUNT = 10;
const CONNECTION_TIMEOUT_MS = 10_000;
const MEGA = 1_000_000;

const HELP = `Использование: node speedtest.mjs <url>
Укажите прямой HTTP(S)-адрес файла. Утилита скачает его 10 раз подряд и выведет
среднее время запроса, суммарный объём и скорость скачивания.

  --help  Показать справку`;

/** @typedef {{ bytes: number, durationMs: number }} DownloadMeasurement */
/** @typedef {{ totalBytes: number, averageRequestDurationMs: number, bitsPerSecond: number }} SpeedtestResult */
/** @typedef {{ onComplete: (result: SpeedtestResult) => void | Promise<void> }} SpeedtestOutput */

/** @param {DownloadMeasurement} measurement */
function calculateBitsPerSecond({ bytes, durationMs }) {
  return (bytes * 8) / (durationMs / 1000);
}

/**
 * @param {URL} url
 * @returns {Promise<DownloadMeasurement>}
 */
function downloadOnce(url) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const request = transport.get(url);

    request.once('socket', (socket) => {
      if (request.reusedSocket) return;

      const connectedEvent = isHttps ? 'secureConnect' : 'connect';
      const timer = setTimeout(() => {
        request.destroy(new Error(`Таймаут установки соединения (${CONNECTION_TIMEOUT_MS / 1000} с)`));
      }, CONNECTION_TIMEOUT_MS);

      function stopConnectionTimer() {
        clearTimeout(timer);
        socket.off(connectedEvent, stopConnectionTimer);
      }

      socket.once(connectedEvent, stopConnectionTimer);
      request.once('close', stopConnectionTimer);
    });

    request.once('error', reject);
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      reject(new Error(`HTTP ${response.statusCode}, ожидался HTTP 200`));
    });

    request.once('response', async (response) => {
      response.once('error', (error) => {
        reject(new Error(`Ответ оборван: ${error.message}`, { cause: error }));
      });

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}, ожидался HTTP 200`));
        request.destroy();
        return;
      }

      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
      });
      response.once('close', () => {
        if (!response.readableEnded) {
          reject(new Error('Ответ оборван до завершения чтения тела'));
        }
      });
      response.once('end', () => {
        if (!response.complete) {
          reject(new Error('Ответ оборван до завершения чтения тела'));
        } else if (bytes === 0) {
          reject(new Error('Пустое тело ответа'));
        } else {
          resolve({ bytes, durationMs: performance.now() - startedAt });
        }
      });
    });
  });
}

/**
 * @param {URL} url
 * @param {SpeedtestOutput} output
 * @returns {Promise<void>}
 */
async function measureRepeatedDownloads(url, output) {
  let totalBytes = 0;
  let totalDurationMs = 0;

  for (let attempt = 1; attempt <= DOWNLOAD_COUNT; attempt += 1) {
    try {
      const { bytes, durationMs } = await downloadOnce(url);
      totalBytes += bytes;
      totalDurationMs += durationMs;
    } catch (error) {
      throw new Error(`Попытка ${attempt}/${DOWNLOAD_COUNT}: ${error.message}`, { cause: error });
    }
  }

  await output.onComplete({
    totalBytes,
    averageRequestDurationMs: totalDurationMs / DOWNLOAD_COUNT,
    bitsPerSecond: calculateBitsPerSecond({ bytes: totalBytes, durationMs: totalDurationMs }),
  });
}

/** @param {SpeedtestResult} result */
function reportToConsole({ totalBytes, averageRequestDurationMs, bitsPerSecond }) {
  console.log([
    `Среднее время запроса: ${averageRequestDurationMs.toFixed(2)} мс`,
    `Суммарный объём: ${(totalBytes / MEGA).toFixed(6)} МБ`,
    `Скорость скачивания: ${(bitsPerSecond / MEGA).toFixed(2)} Мбит/с`,
  ].join('\n'));
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Код выхода CLI.
 */
async function main(argv) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { help: { type: 'boolean' } },
      allowPositionals: true,
    });

    if (values.help) {
      console.log(HELP);
      return 0;
    }

    if (positionals.length !== 1) {
      throw new Error('Укажите ровно один URL файла. Справка: node speedtest.mjs --help');
    }

    const [address] = positionals;
    const url = URL.parse(address);
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Некорректный URL. Укажите абсолютный адрес с протоколом HTTP или HTTPS');
    }

    await measureRepeatedDownloads(url, { onComplete: reportToConsole });
    return 0;
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    return 1;
  }
}

const [,, ...args] = process.argv;

if (args.length === 1) {
  process.exitCode = await main(args);
} else {
  console.log(HELP);
}
