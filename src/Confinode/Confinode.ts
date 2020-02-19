import { basename, dirname, join, resolve } from 'path'

import ConfigDescription, { anyItem } from '../ConfigDescription'
import ConfinodeError from '../ConfinodeError'
import FileDescription, { defaultFiles, isFileBasename } from '../FileDescription'
import Loader, { LoaderManager } from '../Loader'
import { Level, Message, MessageId, MessageParameters } from '../messages'
import { isExisting } from '../utils'
import ConfinodeOptions, { ConfinodeParameters, defaultConfig, filesAreFilters } from './ConfinodeOptions'
import ConfinodeResult from '../ConfinodeResult'
import {
  Request,
  asyncExecute,
  requestIsFolder,
  requestFileExits,
  requestFolderContent,
  requestLoadConfigFile,
  syncExecute,
} from './synchronization'

// The type for polymorphic methods
type SearchFunctionType<T extends object, M extends 'async' | 'sync'> = M extends 'async'
  ? {
      (searchStart?: string): Promise<ConfinodeResult<T> | undefined>
      sync: (searchStart?: string) => ConfinodeResult<T> | undefined
    }
  : {
      (searchStart?: string): ConfinodeResult<T> | undefined
      async: (searchStart?: string) => Promise<ConfinodeResult<T> | undefined>
    }
type LoadFunctionType<T extends object, M extends 'async' | 'sync'> = M extends 'async'
  ? {
      (name: string): Promise<ConfinodeResult<T> | undefined>
      sync: (name: string) => ConfinodeResult<T> | undefined
    }
  : {
      (name: string): ConfinodeResult<T> | undefined
      async: (name: string) => Promise<ConfinodeResult<T> | undefined>
    }

/**
 * The main Confinode class.
 */
export default class Confinode<T extends object = any, M extends 'async' | 'sync' = 'async'> {
  public readonly search: SearchFunctionType<T, M>
  public readonly load: LoadFunctionType<T, M>

  private readonly parameters: ConfinodeParameters

  private readonly loaderManager: LoaderManager = new LoaderManager()

  private folderCache: { [folder: string]: string[] } = {}
  private contentCache: { [path: string]: ConfinodeResult<T> | undefined } = {}

  public constructor(
    public readonly name: string,
    private readonly description: ConfigDescription<T> = anyItem(),
    options?: ConfinodeOptions<M>
  ) {
    // Load default option (prevent null or undefined provided options to remove default ones)
    this.parameters = Object.entries(options ?? {}).reduce(
      (previous, [key, value]) => {
        if (value !== undefined && value !== null) {
          previous[key] = value
        }
        return previous
      },
      { ...defaultConfig } as any
    )

    // Prepare options
    this.parameters.modulePaths = this.parameters.modulePaths.map(path => resolve(process.cwd(), path))
    this.parameters.modulePaths.unshift(process.cwd())
    if (!options?.files || filesAreFilters(options.files)) {
      this.parameters.files = defaultFiles(name)
    }
    if (options?.files && filesAreFilters(options.files)) {
      this.parameters.files = options.files.reduce(
        (previous, filter) => filter(previous),
        this.parameters.files
      )
    }
    if (!options?.mode) {
      this.parameters.mode = 'async'
    }

    // Prepare polymorphic methods
    let _search: any
    if (this.parameters.mode === 'async') {
      _search = this.asyncSearch
      _search.sync = (searchStart?: string) => this.syncSearch(searchStart)
    } else {
      _search = this.syncSearch
      _search.async = (searchStart?: string) => this.asyncSearch(searchStart)
    }
    this.search = _search as SearchFunctionType<T, M>
    let _load: any
    if (this.parameters.mode === 'async') {
      _load = this.asyncLoad
      _load.sync = (file: string) => this.syncLoad(file)
    } else {
      _load = this.syncLoad
      _load.async = (file: string) => this.asyncLoad(file)
    }
    this.load = _load as LoadFunctionType<T, M>
  }

  /**
   * Clear the cache.
   */
  public clearCache(): void {
    this.folderCache = {}
    this.contentCache = {}
  }

  /**
   * Asynchronously search for configuration.
   *
   * @param searchStart - The place where search will start, current folder by default.
   * @returns A promise resolving to the configuration if found, undefined otherwise.
   */
  private async asyncSearch(searchStart?: string): Promise<ConfinodeResult<T> | undefined> {
    return asyncExecute(this.searchConfig(searchStart))
  }

  /**
   * Synchronously search for configuration.
   *
   * @param searchStart - The place where search will start, current folder by default.
   * @returns The configuration if found, undefined otherwise.
   */
  private syncSearch(searchStart?: string): ConfinodeResult<T> | undefined {
    return syncExecute(this.searchConfig(searchStart))
  }

  /**
   * Search for configuration.
   *
   * @param searchStart - The place where search will start, current folder by default.
   * @returns A promise resolving to the configuration if found, undefined otherwise.
   */
  private *searchConfig(
    searchStart: string = process.cwd()
  ): Generator<Request, ConfinodeResult<T> | undefined, any> {
    try {
      return yield* this.searchConfigInFolder(
        (yield requestIsFolder(searchStart)) ? searchStart : dirname(searchStart)
      )
    } catch (e) {
      /* istanbul ignore next */
      this.log('internal', e)
      /* istanbul ignore next */
      return undefined
    }
  }

  /**
   * Search for configuration in given folder. This is a recursive method.
   *
   * @param folder - The folder to search in.
   * @returns A promise resolving to the configuration if found, undefined otherwise.
   */
  private *searchConfigInFolder(folder: string): Generator<Request, ConfinodeResult<T> | undefined, any> {
    // Get absolute folder
    const absoluteFolder = resolve(process.cwd(), folder)
    this.log(Level.Trace, 'searchInFolder', absoluteFolder)

    // See if already in cache
    if (absoluteFolder in this.contentCache) {
      this.log(Level.Trace, 'loadedFromCache')
      return this.contentCache[absoluteFolder]
    }

    // Search configuration files
    let result: ConfinodeResult<T> | undefined
    try {
      result = yield* this.searchConfigUsingDescriptions(absoluteFolder)
      // Search in parent if not found here
      if (result === undefined && absoluteFolder !== this.parameters.searchStop) {
        const parentFolder = dirname(absoluteFolder)
        if (parentFolder !== absoluteFolder) {
          result = yield* this.searchConfigInFolder(parentFolder)
        }
      }
    } catch (e) {
      this.log('loading', e)
    }

    if (this.parameters.cache) {
      this.contentCache[absoluteFolder] = result
    }
    return result
  }

  /**
   * Search for configuration using options descriptions.
   *
   * @param folder - The folder in wich to search.
   * @returns The found elements or undefined.
   */
  private *searchConfigUsingDescriptions(
    folder: string
  ): Generator<Request, ConfinodeResult<T> | undefined | undefined, any> {
    for (const fileDescription of this.parameters.files) {
      const fileAndLoader = yield* this.searchFileAndLoader(folder, fileDescription)
      if (fileAndLoader) {
        const { fileName, loaderName, loader } = fileAndLoader
        const result = yield* this.loadConfigFile(fileName, { name: loaderName, loader })
        if (result) {
          this.log(Level.Information, 'loadedConfiguration', fileName)
          return result
        }
      }
    }
    return undefined
  }

  /**
   * Search a file and its loader matching the given description in the given folder.
   *
   * @param folder - The folder in which to search.
   * @param description - The file description.
   * @returns The found file and loader, or undefined if none.
   */
  private *searchFileAndLoader(
    folder: string,
    description: FileDescription
  ): Generator<Request, { fileName: string; loaderName?: string; loader: Loader } | undefined, any> {
    if (isFileBasename(description)) {
      const searchedPath = join(folder, description)
      const folderName = dirname(searchedPath)
      const baseName = basename(description) + '.'
      let fileNames: string[]
      if (folderName in this.folderCache) {
        fileNames = this.folderCache[folderName]
      } else {
        fileNames = yield requestFolderContent(folderName)
        if (this.parameters.cache) {
          this.folderCache[folderName] = fileNames
        }
      }
      const loaders = fileNames
        .filter(fileName => fileName.startsWith(baseName))
        .map(fileName => {
          const loader = this.loaderManager.getLoaderFor(
            this.parameters.modulePaths,
            fileName,
            fileName.slice(baseName.length)
          )
          return isExisting(loader)
            ? { fileName: join(folderName, fileName), loaderName: loader.name, loader: loader.loader }
            : undefined
        })
        .filter(isExisting)
      if (loaders.length > 0) {
        if (loaders.length > 1) {
          this.log(Level.Warning, 'multipleFiles', searchedPath)
        }
        return loaders[0]
      }
    } else {
      const fileName = join(folder, description.name)
      if (yield requestFileExits(fileName)) {
        return { fileName, loader: description.loader }
      }
    }
    return undefined
  }

  /**
   * Asynchronously load the configuration file.
   *
   * @param name - The name of the configuration file. The name may be an absolute file path, a relative
   * file path, or a module name and an optional file path.
   * @returns A promise resolving to the configuration if loaded, undefined otherwise.
   */
  private async asyncLoad(name: string): Promise<ConfinodeResult<T> | undefined> {
    return asyncExecute(this.loadConfig(name))
  }

  /**
   * Synchronously load the configuration file.
   *
   * @param name - The name of the configuration file. The name may be an absolute file path, a relative
   * file path, or a module name and an optional file path.
   * @returns The configuration if loader, undefined otherwise.
   */
  private syncLoad(name: string): ConfinodeResult<T> | undefined {
    return syncExecute(this.loadConfig(name))
  }

  /**
   * Load configuration from file with given name.
   *
   * @param name - The name of the configuration file. The name may be an absolute file path, a relative
   * file path, or a module name and an optional file path.
   * @param folder - The folder to resolve name from, defaults to current directory.
   * @returns The configuration if loaded, undefined otherwise.
   */
  private *loadConfig(
    name: string,
    folder: string = process.cwd()
  ): Generator<Request, ConfinodeResult<T> | undefined, any> {
    // Search for the real file name
    let fileName: string | undefined
    try {
      fileName = require.resolve(name, { paths: [folder] })
    } catch {
      fileName = undefined
    }

    // Load the content
    try {
      if (!fileName || !(yield requestFileExits(fileName))) {
        throw new ConfinodeError('fileNotFound', name)
      }
      return yield* this.loadConfigFile(fileName)
    } catch (e) {
      this.log('loading', e)
    }

    // Return result
    return undefined
  }

  /**
   * Load the configuration file.
   *
   * @param fileName - The name of the file to load.
   * @param loader - The loader to use, if already found.
   * @returns The method will return the configuration, or undefined if content is empty (the meaning of
   * empty depends on the loader). May throw an error if loading problem.
   */
  private *loadConfigFile(
    fileName: string,
    loader?: { name?: string; loader: Loader }
  ): Generator<Request, ConfinodeResult<T> | undefined, any> {
    const absoluteFile = resolve(process.cwd(), fileName)
    this.log(Level.Trace, 'loadingFile', absoluteFile)
    if (absoluteFile in this.contentCache) {
      this.log(Level.Trace, 'loadedFromCache')
      return this.contentCache[absoluteFile]
    }

    // Search for the loader if not provided
    // TODO Add module paths
    const usedLoader =
      loader ?? this.loaderManager.getLoaderFor(this.parameters.modulePaths, basename(absoluteFile))
    if (!usedLoader) {
      throw new ConfinodeError('noLoaderFound', absoluteFile)
    }
    if (usedLoader.name) {
      this.log(Level.Trace, 'usingLoader', usedLoader.name)
    }

    // Loading file content
    let result: ConfinodeResult<T> | undefined
    const content = yield requestLoadConfigFile(absoluteFile, usedLoader.loader)
    if (content === undefined) {
      this.log(Level.Trace, 'emptyConfiguration')
    } else {
      // TODO Look for indirection
      // TODO Look if extends for heritage

      // Parse file
      result = this.description.parse(content, { keyName: '', fileName, final: true })
      result && (result = new ConfinodeResult(result, { fileName, extends: [] }))
    }

    if (this.parameters.cache) {
      this.contentCache[absoluteFile] = result
    }
    return result
  }

  /**
   * Log the exception as an error of given type.
   *
   * @param errorType - The type of the error.
   * @param exception - The exception to log.
   */
  private log(errorType: 'loading' | 'internal', exception: any): void

  /**
   * Log a message.
   *
   * @param level - The level of the message.
   * @param messageId - The message identifier.
   * @param parameters - The parameters for the message.
   */
  private log<M extends MessageId>(level: Level, messageId: M, ...parameters: MessageParameters[M]): void

  /*
   * Implementation.
   */
  private log<M extends MessageId>(
    levelOrErrorType: any,
    messageIdOrException?: any,
    ...parameters: MessageParameters[M]
  ): void {
    let message: Message<any>
    if (typeof levelOrErrorType === 'string') {
      if (messageIdOrException instanceof ConfinodeError) {
        message = messageIdOrException.internalMessage
      } else {
        const errorMessage =
          messageIdOrException instanceof Error
            ? messageIdOrException.message
            : /* istanbul ignore next */ messageIdOrException.toString()
        /* istanbul ignore else */
        if (levelOrErrorType === 'loading') {
          message = new Message(Level.Error, 'loadingError', errorMessage)
        } else {
          message = new Message(Level.Error, 'internalError', errorMessage)
        }
      }
    } else {
      message = new Message(levelOrErrorType as Level, messageIdOrException as M, ...parameters)
    }
    this.parameters.logger(message)
  }
}
