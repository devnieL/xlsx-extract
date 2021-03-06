var fs = require('fs'),
	expat = require('node-expat'),
	path = require('path'),
	unzip = require('unzip2'),
	util = require('util'),
	events = require('events'),
	endOfLine = require('os').EOL,
	debug = require('debug')('xlsx-extract');

/*

 */

var consts = {
	/*
	 xlsx build in nr formats
	 */
	fmts: {
		0: null,//General
		1: '0',
		2: '0.00',
		3: '#,##0',
		4: '#,##0.00',

		9: '0%',
		10: '0.00%',
		11: '0.00E+00',
		12: '# ?/?',
		13: '# ??/??',
		14: 'mm-dd-yy',
		15: 'd-mmm-yy',
		16: 'd-mmm',
		17: 'mmm-yy',
		18: 'h:mm AM/PM',
		19: 'h:mm:ss AM/PM',
		20: 'h:mm',
		21: 'h:mm:ss',
		22: 'm/d/yy h:mm',

		37: '#,##0 ;(#,##0)',
		38: '#,##0 ;[Red](#,##0)',
		39: '#,##0.00;(#,##0.00)',
		40: '#,##0.00;[Red](#,##0.00)',

		45: 'mm:ss',
		46: '[h]:mm:ss',
		47: 'mmss.0',
		48: '##0.0E+0',
		49: '@'
	},
	alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
};

/*

 */

var _utils = {
	/*
	 converts a raw xlsx-date to js date
	 */
	xlsx_date: function (value, date1904) {
		var date = Math.floor(value),
			time = Math.round(86400 * (value - date)),
			d;
		if (date1904) {
			date += 1462;
		}
		// Open XML stores dates as the number of days from 1 Jan 1900. Well, skipping the incorrect 29 Feb 1900 as a valid day.
		if (date === 60) {
			d = new Date(1900, 1, 29);
		} else {
			if (date > 60) {
				--date;
			}
			/* 1 = Jan 1 1900 */
			d = new Date(1900, 0, 1, 0, 0, 0);
			d.setDate(d.getDate() + date - 1);
		}
		d.setSeconds(time % 60);
		time = Math.floor(time / 60);
		d.setMinutes(time % 60);
		time = Math.floor(time / 60);
		d.setHours(time);
		return d;
	},

	/*
	 converts a column index to chars e.g. 1 -> A
	 */
	numAlpha: function (i) {
		var t = Math.floor(i / 26) - 1;
		return (t > -1 ? this.numAlpha(t) : '') + consts.alphabet.charAt(i % 26);
	},

	/*
	 converts a chars to column index e.g. A -> 1
	 */
	alphaNum: function (name) {
		var result = 0;
		var multiplier = 1;
		for (var i = name.length - 1; i >= 0; i--) {
			var value = ((name[i].charCodeAt(0) - 'A'.charCodeAt(0)) + 1);
			result = result + value * multiplier;
			multiplier = multiplier * 26;
		}
		return (result - 1);
	},

	splitFormats: function (s) {
		/*
		 http://office.microsoft.com/en-gb/excel-help/create-or-delete-a-custom-number-format-HP005199500.aspx?redir=0
		 _-* #,##0\ _€_-;\-* #,##0\ _€_-;_-* "-"??\ _€_-;_-@_-
		 positiv value ; negativ value ; zero; string
		 */
		var fmts = s.split(/(?!\\);/);
		var nr = 0;
		var lastff = {t: 'x'};
		var result = [];
		for (var i = 0; i < fmts.length; i++) {
			var ff = this.parseFmtType(fmts[i]);
			ff = (ff.t === 'l' ? lastff : ff);
			lastff = ff;
			var format = {fmt: fmts[i], fmt_type: ff.t};
			if (ff.f) {
				format.digits = ff.f;
			}
			result.push(format);
			nr++;
		}
		return result;
	},

	containsOnlyChars: function (value, chars) {
		for (var i = 0; i < value.length; i++) {
			if (chars.indexOf(value[i]) < 0) {
				return false;
			}
		}
		return (value.length > 0);
	},

	parseFmtType: function (fmt) {
		//messy hack for extracting some infos from the number format (type and float-digits}
		var s = fmt;
		var b = '';
		while (s.length > 0) {
			var c = s[0];
			s = s.slice(1);
			if ((c === '_') || (c === '\\') || (c === '*')) {
				s = s.slice(1);
			} else if (c === '[') {
				s = s.slice(s.indexOf(']') + 1);
			} else if (c === '"') {
				s = s.slice(s.indexOf('"') + 1);
			} else if ((c === '(') || (c === ')')) {
				//nop
			} else {
				b += c;
			}
		}
		b = b.replace(/#/g, '0').replace(/%/g, '');
		// deal with thousands separator 12000 -> 12 -> formatCode	'#,'
		var sp = b.split(',');
		b = sp[sp.length - 1];
		if (!isNaN(b)) {
			if (b.indexOf('.') >= 0) {
				var di = sp[sp.length - 1].split('.')[1].trim().length;
				if (b.indexOf('E+') >= 0) {
					di += 14;
				}
				return {t: 'f', f: di};
			} else {
				return {t: 'i'};
			}
		} else if (b === '@') {
			return {t: 's'};
		}
		//'-'?? zero value
		if (b === '??') {
			return {t: 'l'}; // last fmt should by used
		}
		sp = b.split(' ');
		//test # ??/??
		if ((sp.length > 1) && (_utils.containsOnlyChars(sp[sp.length - 1], '?/'))) {
			// '# ?/?', '# ??/??',
			var digits = sp[sp.length - 1].split('/')[0].trim().length + 1;
			return {t: 'f', f: digits};
		}
		//date format?
		if (_utils.containsOnlyChars(b, 'tmdyhseAPTMH:/-.0 ')) {
			return {t: 'd'};
		}
		debug('bef:', fmt, 'aft:', b);
		return {t: 'x'};
	}

};

/*

 */

function Cell() {
	this.val = null;
	this.typ = null;
	this.col = -1;
	this.fmt = null;
	this.raw = null;
}
Cell.prototype.getFormat = function (options) {
	switch (options.format) {
		case 'json':
			return this.toJson();
		case 'array':
			return this.val;
		case 'obj':
			return this;
		//case 'tsv':
		default:
			return this.toTSV(options.tsv_float_comma, options.tsv_delimiter);
	}
};
Cell.prototype.toTSV = function (tsv_float_comma, delimiter) {
	var val;

	delimiter = delimiter || '\t';

	if (this.val === null) {
		val = '';
	}
	else {
		if (util.isDate(this.val)) {
			val = this.val.toISOString();
		} else {
			val = this.val.toString();
		}
	}

	if (tsv_float_comma && (typeof this.val === 'number')) {
		val = val.replace('.', ',');
	}

	if (val.indexOf('"') > -1 || val.indexOf('\n') > -1 || val.indexOf('\r') > -1 || val.indexOf(delimiter) > -1) {
		val = '"' + val.replace(/"/g, '""') + '"';
	}

	return val;
};
Cell.prototype.toJson = function () {
	return JSON.stringify(this.val);
};
Cell.prototype.getEffectiveNumFormat = function () {
	if ((!this.fmt) || (this.fmt.fmts.length === 0)) {
		return null;
	}
	if (this.fmt.fmts.length === 1) {
		return this.fmt.fmts[0];
	}
	if (isNaN(this.val)) {
		return this.fmt.fmts[3];
	}
	if (this.val < 0) {
		return this.fmt.fmts[1];
	}
	if (this.val > 0) {
		return this.fmt.fmts[0];
	}
	return this.fmt.fmts[(this.fmt.fmts.length > 2) ? 2 : 0];

};
Cell.prototype.applyNumFormat = function (options) {
	var usefmt = this.getEffectiveNumFormat();
	if (usefmt) {
		switch (usefmt.fmt_type) {
			case 'd':
				if (options.convert_values.dates) {
					this.val = _utils.xlsx_date(this.val, options.date1904);
				}
				break;
			case 'i':
				if (options.convert_values.ints) {
					var i = null;
					if (this.fmt && this.fmt.fmt === '0\\ %') {
						i = Math.round(parseFloat(this.val * 100));
					} else {
						i = parseInt(this.val, 10);
					}
					if (!isNaN(i)) {
						this.val = i;
					}
				}
				break;
			case 'f':
				if ((usefmt.digits > 0) && options.convert_values.floats) {
                    if (options.round_floats) {
                        this.val = this.val.toFixed(usefmt.digits)
                    }

					var v = parseFloat(this.val);
					if (!isNaN(v)) {
						this.val = v;
					}
				}
				break;
			default:
				//nop
				break;
		}
	}
};
Cell.prototype.convertValue = function (options) {
	if (this.val !== null) {
		switch (this.typ) {
			case 'n':
				var v = parseFloat(this.val);
				if (!isNaN(v)) {
					this.val = v;
				}
				if ((this.fmt) && (options.convert_values)) {
					this.applyNumFormat(options);
				}
				break;
			case 's':
			case 'str':
			case 'inlineStr':
				break; // string, do nothing
			case 'b':
				if (options.convert_values && options.convert_values.bools) {
					if (['0', 'FALSE', 'false'].indexOf(this.val) >= 0) {
						this.val = false;
					} else if (['1', 'TRUE', 'true'].indexOf(this.val) >= 0) {
						this.val = true;
					} else {
						debug('Unknown boolean:', this.val);
					}
				}
				break;
			case 'e':
				debug('Error cell type: Value will be invalid ("#REF!", "#NAME?", "#VALUE!" or similar).');
				break;
			default:
				debug('Unknown cell type: "%s"', this.typ);
		}
	}
};

/*

 */
function Row() {
	this.cells = [];
}
Row.prototype.getFormat = function (options) {
	switch (options.format) {
		case 'json':
			return this.toJson();
		case 'array':
			return this.toArray();
		case 'obj':
			return this;
		//case 'tsv':
		default:
			return this.toTSV(options.tsv_float_comma, options.tsv_delimiter);
	}
};
Row.prototype.toTSV = function (tsv_float_comma, tsv_delimiter) {
	tsv_delimiter = tsv_delimiter || '\t';
	return this.cells.map(function (cell) {
			return cell.toTSV(tsv_float_comma, tsv_delimiter);
		}).join(tsv_delimiter) + endOfLine;
};
Row.prototype.toJson = function () {
	return JSON.stringify(this.toArray());
};
Row.prototype.toArray = function () {
	return this.cells.map(function (cell) {
		return cell.val;
	});
};
Row.prototype.push = function (cell) {
	this.cells.push(cell);
};
Row.prototype.count = function () {
	return this.cells.length;
};
Row.prototype.isEmpty = function () {
	return (this.cells.length === 0) || (this.cells.filter(function (cell) {
			return (cell.val !== null);
		}).length === 0);
};

/*

 */
function Sheet() {
	this.name = null;
}
Sheet.prototype.getFormat = function (options) {
	switch (options.format) {
		case 'json':
			return this.toJson();
		case 'array':
			return this.toArray();
		case 'obj':
			return this;
		//case 'tsv':
		default:
			return this.toTSV(options.tsv_float_comma, options.tsv_delimiter);
	}
};
Sheet.prototype.toTSV = function (tsv_float_comma, tsv_delimiter) {
	tsv_delimiter = tsv_delimiter || '\t';
	return this.toArray().join(tsv_delimiter) + endOfLine;
};
Sheet.prototype.toJson = function () {
	return JSON.stringify({
		name: this.name,
		nr: this.id
	});
};
Sheet.prototype.toArray = function () {
	return [this.name, this.rid, this.id];
};

/*

 */

function Workbook() {
	this.sheets = [];
}
Workbook.prototype.getById = function (id) {
	return this.sheets.filter(function (sheet) {
		return sheet.rid === 'rId' + id;
	})[0];
};
Workbook.prototype.getByNr = function (nr) {
	return this.sheets.filter(function (sheet) {
		return parseInt(sheet.id, 10) === parseInt(nr, 10);
	})[0];
};
Workbook.prototype.getByName = function (name) {
	return this.sheets.filter(function (sheet) {
		return sheet.name === name;
	})[0];
};
Workbook.prototype.validate = function (rid) {
	var sheet = this.sheets.filter(function (sheet) {
		return sheet.rid === rid;
	})[0];
	if (!sheet) {
		sheet = new Sheet();
		sheet.rid = rid;
		this.sheets.push(sheet);
	}
	return sheet;
};

/*

 */

function XLSXReader(filename, options) {
	this.filename = filename;
	this.options = {
		sheet_nr: '1',
		ignore_header: 0,
		date1904: false,
		include_empty_rows: false,
		tsv_float_comma: false,
		tsv_delimiter: '\t',
		format: 'array',
		raw_values: false,
		round_floats: true,
		convert_values: {
			ints: true,
			floats: true,
			dates: true,
			bools: true
		}
	};
	util._extend(this.options, options);
}
XLSXReader.prototype.parseXMLSheet = function (entry, formatstyles, strings, cb) {
	var caller = this;
	/*
	 A1 -> 0
	 A2 -> 0
	 B2 -> 1
	 */
	var getColumnFromDef = function (coldef) {
		var cc = '';
		for (var i = 0; i < coldef.length; i++) {
			if (isNaN(coldef[i])) {
				cc += coldef[i];
			} else {
				break;
			}
		}
		return _utils.alphaNum(cc);
	};

	/*
	 converts cell value according to the cell type & number format
	 */
	var parser = expat.createParser();
	var addvalue = false;
	var row;
	var rownum = 1;
	var cell;
	parser.on('startElement', function (name, attrs) {
		if (name === 'row') {
			if (caller.options.include_empty_rows) {
				var rownr = parseInt(attrs.r, 10);
				//TODO: if rows are not sorted, we are screwed - track and warn user if so
				//reading them first and sort is not wanted, since rows are streamed
				while (rownum < rownr) {
					rownum++;
					cb(null, new Row());
				}
				rownum = rownr + 1;
			}
			row = new Row();
		} else if (name === 'c') {
			cell = new Cell();
			cell.typ = (attrs.t ? attrs.t : 'n');
			cell.fmt = attrs.s ? formatstyles[attrs.s] : null;
			cell.col = getColumnFromDef(attrs.r);
			//TODO: if cols are not sorted, we are screwed - track and warn user if so
			while (row.count() < cell.col) {
				var empty = new Cell();
				empty.col = row.count();
				row.push(empty);
				cb(null, null, cell);
			}
			row.push(cell);
		} else if (name === 'v') {
			addvalue = true;
		} else if (name === 't') { // support for inline text <c t="inlineStr"><is><t>Product</t></is></c>
			addvalue = true;
//		} else {
//			console.log(rownum, 'unknown',name);
		}
	});
	parser.on('endElement', function (name) {
		if (name === 'row') {
			if (row) {
				cb(null, row);
			}
		} else if (name === 'v') {
			addvalue = false;
		} else if (name === 't') {
			addvalue = false;
		} else if (name === 'c') {
			addvalue = false;
			if (cell.col >= 0) {
				if (cell.typ === 's') {
					cell.val = strings[parseInt(cell.val, 10)].val;
				}
				cell.raw = cell.val;
				if (!caller.options.raw_values) {
					cell.convertValue(caller.options);
				}
				cb(null, null, cell);
			}
		}
	});
	parser.on('text', function (txt) {
		if (addvalue) {
			cell.val = (cell.val ? cell.val : '') + txt;
		}
	});
	parser.on('error', function (err) {
		cb(err || 'unknown error');
	});
	parser.on('close', cb);
	entry.pipe(parser);
};
XLSXReader.prototype.parseXMLWorkbook = function (entry, workbook, cb) {
	var parser = expat.createParser();
	parser.on('startElement', function (name, attrs) {
		if (name === 'sheet') {
			var sheet = workbook.validate(attrs['r:id']);
			sheet.id = attrs.sheetId;
			sheet.name = attrs.name;
		}
	});
	parser.on('error', function (err) {
		debug('workbook', err);
	});
	parser.on('close', cb);
	entry.pipe(parser);
};
XLSXReader.prototype.parseXMLWorkbookRelations = function (entry, workbook, cb) {
	var parser = expat.createParser();
	parser.on('startElement', function (name, attrs) {
		if ((name === 'Relationship') && (typeof attrs.Target === 'string') && (attrs.Target.toLowerCase().indexOf('worksheets/sheet') >= 0 )) {
			var sheet = workbook.validate(attrs.Id);
			sheet.filename = attrs.Target;
		}
	});
	parser.on('error', function (err) {
		debug('workbook.relations', err);
	});
	parser.on('close', cb);
	entry.pipe(parser);
};
XLSXReader.prototype.parseXMLStyles = function (entry, formatstyles, cb) {
	var parser = expat.createParser();
	var numFmts = {};
	var cellXfs = [];
	var cellXfs_collect = false;
	parser.on('startElement', function (name, attrs) {
		if (name === 'numFmt') {
			numFmts[attrs.numFmtId] = attrs.formatCode;
		} else if (name === 'cellXfs') {
			cellXfs_collect = true;
		} else if ((cellXfs_collect) && (name === 'xf')) {
			var fmtnr = parseInt(attrs.numFmtId);
			cellXfs.push(fmtnr);
			var stylenr = (cellXfs.length - 1).toString();
			var fmt = numFmts[fmtnr] || consts.fmts[fmtnr];
			formatstyles[stylenr] = {
				fmt: fmt,
				fmtnr: fmtnr,
				fmts: (fmt ? _utils.splitFormats(fmt) : []),
				def: attrs
			};
		}
	});
	parser.on('endElement', function (name) {
		if (name === 'cellXfs') {
			cellXfs_collect = false;
		}
	});
	parser.on('error', function (err) {
		debug('styles', err);
	});
	parser.on('close', cb);
	entry.pipe(parser);
};
XLSXReader.prototype.parseXMLStrings = function (entry, strings, cb) {
	var parser = expat.createParser();
	var strings_collect = false;
	var sl = [];
	var s = '';
	parser.on('startElement', function (name) {
		if (name === 'si') {
			sl = [];
		}
		if (name === 't') {
			strings_collect = true;
			s = '';
		}
	});
	parser.on('endElement', function (name) {
		if (name === 't') {
			sl.push(s);
			strings_collect = false;
		}
		if (name === 'si') {
			strings.push({val: sl.join('')});
		}
	});
	parser.on('text', function (txt) {
		if (strings_collect) {
			s = s + txt;
		}
	});
	parser.on('error', function (err) {
		debug('strings', err);
	});
	parser.on('close', function () {
		cb();
	});
	entry.pipe(parser);
};
XLSXReader.prototype.parseXML = function (cb) {
	var strings = [];
	var formatstyles = {};
	var workbook = new Workbook();
	var caller = this;
	var collecting = 1;
	var running = 1;

	function finish() {
		if (running === 0) {
			cb({});
		}
	}

	function parseSheet() {
		var sheet = null;
		var lookup = null;
		if (caller.options.sheet_name) {
			sheet = workbook.getByName(caller.options.sheet_name);
		} else if (caller.options.sheet_id) {
			sheet = workbook.getById(caller.options.sheet_id);
		} else if (caller.options.sheet_nr) {
			sheet = workbook.getByNr(caller.options.sheet_nr);
		}
		if ((sheet) && (sheet.filename)) {
			lookup = 'xl/' + sheet.filename;
			cb({sheet: sheet});
		} else {
			lookup = 'xl/worksheets/sheet' + caller.options.sheet_nr + '.xml';
		}
		fs.createReadStream(caller.filename)
			.pipe(unzip.Parse())
			.on('error', function (error) { 
				cb({ err: error }); 
				finish();
			})
			.on('entry', function (entry) {
				if (entry.path === lookup) {
					running++;
					var count = 1;
					caller.parseXMLSheet(entry, formatstyles, strings, function (err, row, cell) {
						if (err) {
							cb({err: err});
						} else if (cell) {
							if (count > caller.options.ignore_header) {
								cb({cell: cell});
							}
						} else if (row) {
							if (count > caller.options.ignore_header) {
								cb({row: row});
							}
							count++;
						} else {
							running--;
							finish();
						}
					});
				} else {
					entry.autodrain();
				}
			})
			.on('close', function () {
				running--;
				finish();
			});
	}

	function startParseSheet() {
		collecting--;
		if (collecting == 0) parseSheet();
	}

	//first get styles & strings
	fs.createReadStream(this.filename)
		.pipe(unzip.Parse())
		.on('error', function (error) { 
			cb({ err: error }); 
			cb({}); 
		})
		.on('entry', function (entry) {
			if (entry.path === 'xl/sharedStrings.xml') {
				collecting++;
				caller.parseXMLStrings(entry, strings, startParseSheet);
			} else if (entry.path === 'xl/styles.xml') {
				collecting++;
				caller.parseXMLStyles(entry, formatstyles, startParseSheet);
			} else if (entry.path === 'xl/workbook.xml') {
				collecting++;
				caller.parseXMLWorkbook(entry, workbook, startParseSheet);
			} else if (entry.path === 'xl/_rels/workbook.xml.rels') {
				collecting++;
				caller.parseXMLWorkbookRelations(entry, workbook, startParseSheet);
			} else {
				entry.autodrain();
			}
		})
		.on('close', function () {
			startParseSheet();
		});
};
XLSXReader.prototype.read = function (cb) {
	var caller = this;
	this.parseXML(function (part) {
		if (part.err) {
			cb('error', part.err);
		} else if (part.cell) {
			cb('cell', part.cell.getFormat(caller.options));
		} else if (part.row) {
//			if ((caller.options.include_empty_rows) || (!part.row.isEmpty()))
			cb('row', part.row.getFormat(caller.options));
		} else if (part.sheet) {
			cb('sheet', part.sheet.getFormat(caller.options));
		} else {
			cb('end');
		}
	});
};

/*

 */

function XLSX() {
	events.EventEmitter.call(this);
}
util.inherits(XLSX, events.EventEmitter);
XLSX.utils = _utils;
XLSX.consts = consts;
XLSX.prototype.extract = function (filename, options) {
	var caller = this;
	var reader = new XLSXReader(filename, options);
	reader.read(function (what, data) {
		caller.emit(what, data);
	});
	return this;
};
XLSX.prototype.convert = function (filename, destfile, options) {
	options = options || {};

	if ((!options.format) && ((path.extname(destfile).toLowerCase() === '.json'))) {
		options.format = 'json';
	}
	if (options.format !== 'json') {
		options.format = 'tsv';
	}

	var caller = this;
	var start = true;
	var isJSON = options.format !== 'tsv';
	var writeable;
	try {
		writeable = fs.createWriteStream(destfile);
		if (isJSON) {
			writeable.write('[');
		}
	} catch (e) {
		caller.emit('error', e);
		caller.emit('end');
		return;
	}
	writeable.on('close', function () {
		caller.emit('end');
	});
	var reader = new XLSXReader(filename, options);
	reader.read(function (what, data) {
		switch (what) {
			case 'error':
				caller.emit('error', data);
				break;
			case 'cell':
				caller.emit('cell', data);
				break;
			case 'row':
				if (isJSON) {
					if (start) {
						start = false;
						writeable.write(endOfLine);
					} else {
						writeable.write(',' + endOfLine);
					}
				}
				caller.emit('row', data);
				writeable.write(data);
				break;
			case 'end':
				if (isJSON) {
					writeable.write(endOfLine + ']');
				}
				writeable.end();
				break;
		}
	});
	return this;
};

/*

 */

exports.XLSX = XLSX;
