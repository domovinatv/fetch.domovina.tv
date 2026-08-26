"use strict";
/**
 * Minimalni ZIP writer (store + deflate) — bez vanjskih ovisnosti.
 *
 * Postoji zbog EPUB-a: EPUB je ZIP arhiva s jednim tvrdim pravilom — prvi
 * zapis MORA biti `mimetype`, spremljen NEKOMPRIMIRANO (metoda 0) i bez
 * extra-fielda. Node nema ugrađeni ZIP writer, a repo konvencija je "nema
 * vanjskih ovisnosti u pipeline skriptama", pa je ovo ~120 redaka umjesto
 * `archiver`/`jszip`.
 *
 * Ograničenja (namjerna): nema ZIP64 (arhiva < 4 GB), nema enkripcije,
 * imena datoteka su UTF-8 (bit 11 u general purpose flagu).
 */

const zlib = require("zlib");

// CRC-32 tablica (IEEE 802.3 polinom, reflected 0xEDB88320)
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/** Date → (dosTime, dosDate) par kakav ZIP header očekuje. */
function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

class ZipWriter {
    /** @param {Date} [mtime] fiksni timestamp za sve zapise (reproducibilni build) */
    constructor(mtime) {
        this.entries = [];
        this.mtime = mtime || new Date();
    }

    /**
     * @param {string} name  putanja unutar arhive (npr. "OEBPS/nav.xhtml")
     * @param {Buffer|string} data
     * @param {{store?: boolean}} [opts] store=true → bez kompresije (za `mimetype`)
     */
    add(name, data, opts = {}) {
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
        const store = opts.store === true;
        const compressed = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
        this.entries.push({
            name,
            crc: crc32(raw),
            size: raw.length,
            compressedSize: compressed.length,
            method: store ? 0 : 8,
            compressed,
        });
    }

    /** @returns {Buffer} kompletna ZIP arhiva */
    toBuffer() {
        const { time, date } = dosDateTime(this.mtime);
        const chunks = [];
        const central = [];
        let offset = 0;

        for (const e of this.entries) {
            const nameBuf = Buffer.from(e.name, "utf8");

            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);   // local file header signature
            local.writeUInt16LE(20, 4);           // version needed (2.0)
            local.writeUInt16LE(0x0800, 6);       // flags: bit 11 = UTF-8 imena
            local.writeUInt16LE(e.method, 8);
            local.writeUInt16LE(time, 10);
            local.writeUInt16LE(date, 12);
            local.writeUInt32LE(e.crc, 14);
            local.writeUInt32LE(e.compressedSize, 18);
            local.writeUInt32LE(e.size, 22);
            local.writeUInt16LE(nameBuf.length, 26);
            local.writeUInt16LE(0, 28);           // extra field length = 0 (EPUB traži za mimetype)

            chunks.push(local, nameBuf, e.compressed);

            const cd = Buffer.alloc(46);
            cd.writeUInt32LE(0x02014b50, 0);      // central directory header signature
            cd.writeUInt16LE(20, 4);              // version made by
            cd.writeUInt16LE(20, 6);              // version needed
            cd.writeUInt16LE(0x0800, 8);
            cd.writeUInt16LE(e.method, 10);
            cd.writeUInt16LE(time, 12);
            cd.writeUInt16LE(date, 14);
            cd.writeUInt32LE(e.crc, 16);
            cd.writeUInt32LE(e.compressedSize, 20);
            cd.writeUInt32LE(e.size, 24);
            cd.writeUInt16LE(nameBuf.length, 28);
            cd.writeUInt16LE(0, 30);              // extra
            cd.writeUInt16LE(0, 32);              // comment
            cd.writeUInt16LE(0, 34);              // disk number
            cd.writeUInt16LE(0, 36);              // internal attrs
            cd.writeUInt32LE(0, 38);              // external attrs
            cd.writeUInt32LE(offset, 42);         // offset local headera
            central.push(cd, nameBuf);

            offset += local.length + nameBuf.length + e.compressed.length;
        }

        const centralBuf = Buffer.concat(central);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);         // end of central directory
        end.writeUInt16LE(0, 4);
        end.writeUInt16LE(0, 6);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(centralBuf.length, 12);
        end.writeUInt32LE(offset, 16);
        end.writeUInt16LE(0, 20);

        return Buffer.concat([...chunks, centralBuf, end]);
    }
}

module.exports = { ZipWriter, crc32 };
