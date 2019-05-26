import path from "path"
import fs from "fs"

import yargs from "yargs"
import fsp from "@absolunet/fsp"
import {noop} from "lodash"
import globby from "globby"
import archiver from "archiver"
import {exec} from "pkg"
import promiseSequence from "promise-sequence"
import whichPromise from "which-promise"
import execa from "execa"
import jaidLogger from "jaid-logger"
import stringifyAuthor from "stringify-author"

const logger = jaidLogger(_PKG_TITLE)

const findDpkgDebFile = async () => {
  try {
    return await whichPromise("dpkg-deb")
  } catch {
    return false
  }
}

const job = async argv => {
  const packageFolder = process.cwd()
  const buildFolder = path.join(packageFolder, "dist", "package", "production")
  const buildFolderExists = await fsp.pathExists(buildFolder)
  if (!buildFolderExists) {
    logger.warn(`Build folder ${buildFolder} not found`)
    process.exit(1)
  }
  const packageJsonFile = path.join(buildFolder, "package.json")
  const packageJsonFileExists = await fsp.pathExists(packageJsonFile)
  if (!packageJsonFileExists) {
    logger.warn(`${packageJsonFile} not found`)
    process.exit(1)
  }
  const pkg = await fsp.readJson(packageJsonFile)
  const packageId = `${pkg.name}_v${pkg.version}`
  const getMode = async () => {
    for (const knownMode of ["index", "cli", "app"]) {
      const exists = await fsp.pathExists(path.join(buildFolder, `${knownMode}.js`))
      if (exists) {
        logger.info("Mode: %s", knownMode)
        return knownMode
      }
    }
    logger.warn("No mode determined")
  }
  const mode = await getMode()
  const releaseFolder = path.join(packageFolder, "dist", "github")
  const [copyList, miniArchiveList] = await Promise.all([
    globby(["readme.*", "*.d.ts", "package.json", "license.*", "thirdPartyLicenses.*"], {
      cwd: buildFolder,
      case: false,
      onlyFiles: true,
    }),
    globby(["*.{ts,js,jsx}", "package.json", "license.*", "thirdPartyLicenses.*"], {
      cwd: buildFolder,
      case: false,
      onlyFiles: true,
    }),
    fsp.mkdirp(releaseFolder),
  ])
  await fsp.emptyDir(releaseFolder)
  const releaseTasks = []
  for (const file of copyList) {
    const from = path.join(buildFolder, file)
    const to = path.join(releaseFolder, file)
    releaseTasks.push(fsp.copy(from, to))
  }
  const fullArchive = archiver("zip", {level: 9})
  fullArchive.directory(buildFolder, false)
  fullArchive.pipe(path.join(releaseFolder, `${packageId}.zip`) |> fs.createWriteStream)
  releaseTasks.push(fullArchive.finalize())
  const miniArchive = archiver("zip", {level: 9})
  for (const file of miniArchiveList) {
    miniArchive.file(path.join(buildFolder, file), {name: file})
  }
  miniArchive.pipe(path.join(releaseFolder, `${packageId}_min.zip`) |> fs.createWriteStream)
  releaseTasks.push(miniArchive.finalize())
  if (mode === "cli" || mode === "app") {
    const pkgOptions = [
      path.join(buildFolder, `${mode}.js`),
      "--config",
      path.join(buildFolder, "package.json"),
      "--options",
      "max_old_space_size=4000",
      "--public",
    ]
    const targets = [
      {
        id: "latest-win-x64",
        file: `${packageId}_windows_x64`,
      },
      {
        id: "latest-macos-x64",
        file: `${packageId}_mac_x64`,
      },
      {
        id: "latest-linux-x64",
        file: `${packageId}_linux_x64`,
      },
      {
        id: "latest-alpine-x64",
        file: `${packageId}_alpine_x64`,
      },
    ]
    const compileExecutableTasks = targets.map(({id, file}) => () => exec([...pkgOptions, "--target", id, "--output", path.join(releaseFolder, file)]))
    const dpkgDebFile = await findDpkgDebFile()
    if (dpkgDebFile) {
      const buildDebTask = async () => {
        const scriptBinaryFile = `${packageId}_linux_x64`
        const debFolder = path.join(packageFolder, "dist", "deb")
        const debBinFolder = path.join(debFolder, "usr", "local", "bin")
        await fsp.ensureDir(debBinFolder)
        const debBinFile = path.join(debBinFolder, pkg.name)
        await fsp.copyFile(path.join(releaseFolder, scriptBinaryFile), debBinFile)
        const {size} = await fsp.stat(debBinFile)
        const debInfo = {
          Package: pkg.name,
          Version: pkg.version,
          "Standards-Version": pkg.version,
          Maintainer: pkg.author |> stringifyAuthor,
          Description: pkg.description,
          "Installed-Size": Math.ceil(size / 1024),
          Section: "base",
          Priority: "optional",
          Architecture: "amd64",
        }
        |> Object.entries
        |> #.map(([key, value]) => `${key}: ${value}`)
        |> #.join("\n")
        await fsp.outputFile(path.join(debFolder, "DEBIAN", "control"), `${debInfo}\n`, "utf8")
        await execa(dpkgDebFile, ["--build", debFolder, releaseFolder])
      }
      compileExecutableTasks.push(buildDebTask)
    } else {
      logger.warn("Skipping deb building, dpkg-deb not found")
    }
    releaseTasks.push(compileExecutableTasks |> promiseSequence)
  }
  await Promise.all(releaseTasks)
}

yargs.command("$0", "Creates some release files", noop, job).argv