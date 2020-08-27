/**
 * Aliyun oss plugin
 * support webpack version >= 3.0
 */
const fs = require('fs')
const path = require('path')
const URL = require('url')
const oss = require('ali-oss')
const globby = require('globby')
require('colors')

module.exports = class WebpackAliyunOss {
	constructor(options) {
		this.config = Object.assign({
			test: false,
			verbose: true,
			dist: '',
			buildRoot: '.',
			deleteOrigin: false,
			deleteEmptyDir: false,
			emptyDirectory: [],
			timeout: 30 * 1000,
			setOssPath: null,
			setHeaders: null
		}, options)

		this.configErrStr = this.checkOptions(options)
	}

	async apply(compiler) {
		if (compiler) {
			this.doWithWebpack(compiler)
		} else {
			await this.doWidthoutWebpack()
		}
	}

	doWithWebpack(compiler) {
		if (compiler.hooks) {
			compiler.hooks.afterEmit.tapPromise('WebpackAliyunOss', async(compilation) => {
				await this.dispatchWithWebpack(compiler, compilation)
			})
		} else {
			compiler.plugin('after-emit', async(compilation, callback) => {
				await this.dispatchWithWebpack(compiler, compilation, callback)
			})
		}

	}
	async dispatchWithWebpack(compiler, compilation, callback) {
		if (typeof callback != 'function') callback = Promise.resolve
		if (this.configErrStr) {
			compilation.errors.push(new Error(this.configErrStr))
			return callback([])
		}

		const outputPath = path.resolve(this.slash(compiler.options.output.path))

		const {
			from = outputPath + '/' + '**', verbose
		} = this.config

		const files = await globby(from)
		if (files.length) {
			let result = await this.upload(files, true, outputPath)
			callback(result)
		} else {
			verbose && console.log('no files to be uploaded')
			callback([])
		}
		
	}

	async doWidthoutWebpack() {
		if (this.configErrStr) return new Error(this.configErrStr)

		const {
			from,
			verbose
		} = this.config
		const files = await globby(from)

		if (files.length) {
			return await this.upload(files)
		} else {
			verbose && console.log('no files to be uploaded')
			return 'no files to be uploaded'
		}
	}

	async upload(files, inWebpack, outputPath = '') {
		const {
			dist,
			buildRoot,
			setHeaders,
			deleteOrigin,
			deleteEmptyDir,
			emptyDirectory,
			setOssPath,
			timeout,
			verbose,
			test,
			region,
			accessKeyId,
			accessKeySecret,
			bucket
		} = this.config
		const o = this

		const client = oss({
			region,
			accessKeyId,
			accessKeySecret,
			bucket
		})

		files = files.map(file => path.resolve(file))

		const splitToken = inWebpack ?
			'/' + outputPath.split('/').slice(-2).join('/') + '/' :
			'/' + path.resolve(buildRoot).split('/').slice(-2).join('/') + '/'

		let cloneFiles = files.slice.call(files)
		let uploadUrlResult = new Set()

		const toUpload = async ()=>{
			let filePath, i = 0,
				len = files.length
			while (i++ < len) {
				filePath = files.shift()

				let ossFilePath = o.slash(path.join(dist, (setOssPath && setOssPath(filePath) || (splitToken && filePath.split(splitToken)[1] || ''))))

				if (test) {
					console.log(filePath.blue, 'is ready to upload to ' + ossFilePath.green)
					continue
				}

				let result = await client.put(ossFilePath, filePath, {
					timeout,
					headers: setHeaders && setHeaders(filePath) || {}
				})

				result.url = o.normalize(result.url)
				uploadUrlResult.add(result.url)
				verbose && console.log(filePath.blue, '\nupload to ' + ossFilePath + ' success,'.green, 'cdn url =>', result.url.green)

				if (deleteOrigin) {
					console.log('delete file path', filePath)
					fs.unlinkSync(filePath)
					if (deleteEmptyDir && files.every(f => f.indexOf(path.dirname(filePath)) === -1))
						o.deleteEmptyDir(filePath)
				}
			}
			return true
		}
		try {
			await toUpload()
			if (emptyDirectory.length) {
				for (let directory of emptyDirectory) {
					this.deleteFolderRecursive(path.resolve(directory))
				}
			}
			return Array.from(uploadUrlResult)
		} catch (err) {
			console.log(`failed to upload to ali oss: ${err.name}-${err.code}: ${err.message}`.red)
			return null
		}

	}

	normalize(url) {
		const tmpArr = url.split(/\/{2,}/)
		if (tmpArr.length > 2) {
			const [protocol, ...rest] = tmpArr

			url = protocol + '//' + rest.join('/')
		}
		const {
			domain,
		} = this.config
		if (domain) {
			let originUrl = URL.parse(url)
			let domainUrl = URL.parse(domain)
			url = URL.format({
				...originUrl,
				protocol:domainUrl.protocol||originUrl.protocol||'http',
				host:domainUrl.host||originUrl.host,
				hostname:domainUrl.hostname||originUrl.hostname,
				
			})
		}
		return url
	}
	deleteFolderRecursive(delPath) {
		if (!fs.existsSync(delPath)) return
		fs.readdirSync(delPath).forEach((file) => {
			const curPath = path.join(delPath, file)
			if (fs.lstatSync(curPath).isDirectory()) { // recurse
				this.deleteFolderRecursive(curPath)
			} else { // delete file
				fs.unlinkSync(curPath)
			}
		})
		fs.rmdirSync(delPath)
	}
	deleteEmptyDir(filePath) {
			let dirname = path.dirname(filePath)
			if (fs.existsSync(dirname) && fs.statSync(dirname).isDirectory()) {
				try {
					let files = fs.readdirSync(dirname)
					if (files.length) return
					fs.rmdirSync(dirname)
					this.config.verbose && console.log('empty directory deleted'.green, dirname)
				} catch (error) {
					console.error(error)
				}
			}
		}
		/**
		 *  convert windows backslash paths to slash paths:foo\\bar --> foo/bar
		 * @param {string} path
		 */
	slash(path) {
		const isExtendedLengthPath = /^\\\\\?\\/.test(path)
		const hasNonAscii = /[^\u0000-\u0080]+/.test(path) // eslint-disable-line no-control-regex

		if (isExtendedLengthPath || hasNonAscii) {
			return path
		}

		return path.replace(/\\/g, '/')
	}
	checkOptions(options = {}) {
		const {
			from,
			region,
			accessKeyId,
			accessKeySecret,
			bucket
		} = options

		let errStr = ''

		if (!region) errStr += '\nregion not specified'
		if (!accessKeyId) errStr += '\naccessKeyId not specified'
		if (!accessKeySecret) errStr += '\naccessKeySecret not specified'
		if (!bucket) errStr += '\nbucket not specified'

		if (Array.isArray(from)) {
			if (from.some(g => typeof g !== 'string')) errStr += '\neach item in from should be a glob string'
		} else {
			let fromType = typeof from
			if (['undefined', 'string'].indexOf(fromType) === -1) errStr += '\nfrom should be string or array'
		}

		return errStr
	}
}