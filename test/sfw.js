const sfw = require('../lib')

const path = require('path')
const fs = require('fs-extra')

describe('entry point', function () {
  let subs, fixtureDir, watchDir, mainLogFile, workerLogFile

  beforeEach(async function () {
    subs = []

    fixtureDir = path.join(__dirname, 'fixture')
    watchDir = await fs.mkdtemp(path.join(fixtureDir, 'watched-'))

    mainLogFile = path.join(fixtureDir, 'main.test.log')
    workerLogFile = path.join(fixtureDir, 'worker.test.log')
  })

  afterEach(async function () {
    if (this.currentTest.state === 'failed') {
      const [mainLog, workerLog] = await Promise.all(
        [mainLogFile, workerLogFile].map(fname => fs.readFile(fname, {encoding: 'utf8'}).catch(() => ''))
      )

      console.log(`main log:\n${mainLog}`)
      console.log(`worker log:\n${workerLog}`)
    }

    const promises = [mainLogFile, workerLogFile].map(fname => fs.unlink(fname).catch(() => {}))
    promises.push(fs.remove(watchDir))
    promises.push(...subs.map(sub => sub.unwatch()))

    await Promise.all(promises)
  })

  describe('configuration', function () {
    it('validates its arguments', async function () {
      await assert.isRejected(sfw.configure(), /requires an option object/)
    })

    it('configures the main thread logger', async function () {
      await sfw.configure({mainLogFile})

      const contents = await fs.readFile(mainLogFile)
      assert.match(contents, /FileLogger opened/)
    })

    it('configures the worker thread logger', async function () {
      await sfw.configure({workerLogFile})

      const contents = await fs.readFile(workerLogFile)
      assert.match(contents, /FileLogger opened/)
    })
  })

  describe('watching a directory', function () {
    beforeEach(async function () {
      await sfw.configure({mainLogFile, workerLogFile})
    })

    it('begins receiving events within that directory', async function () {
      let error = null
      const events = []

      subs.push(await sfw.watch(watchDir, (err, es) => {
        error = err
        events.push(...es)
      }))

      await fs.writeFile(path.join(watchDir, 'file.txt'), 'indeed')

      await until('an event arrives', () => events.length > 0)
      assert.isNull(error)
    })

    it('can watch multiple directories at once and dispatch events appropriately', async function () {
      const errors = []
      const eventsA = []
      const eventsB = []

      const watchDirA = path.join(watchDir, 'dir_a')
      const watchDirB = path.join(watchDir, 'dir_b')
      await Promise.all(
        [watchDirA, watchDirB].map(subdir => fs.mkdir(subdir))
      )

      subs.push(await sfw.watch(watchDirA, (err, es) => {
        errors.push(err)
        eventsA.push(...es)
      }))
      subs.push(await sfw.watch(watchDirB, (err, es) => {
        errors.push(err)
        eventsB.push(...es)
      }))

      const fileA = path.join(watchDirA, 'a.txt')
      await fs.writeFile(fileA, 'file a')
      await until('watcher A picks up its event', () => eventsA.some(event => event.oldPath === fileA))

      const fileB = path.join(watchDirB, 'b.txt')
      await fs.writeFile(fileB, 'file b')
      await until('watcher B picks up its event', () => eventsB.some(event => event.oldPath === fileB))

      // Assert that the streams weren't crossed
      assert.isTrue(errors.every(err => err === null))
      assert.isTrue(eventsA.every(event => event.oldPath !== fileB))
      assert.isTrue(eventsB.every(event => event.oldPath !== fileA))
    })

    describe('events', function () {
      let errors, events

      beforeEach(async function () {
        errors = []
        events = []

        subs.push(await sfw.watch(watchDir, (err, es) => {
          errors.push(err)
          events.push(...es)
        }))
      })

      function specMatches (spec, event) {
        return (spec.type === undefined || event.type === spec.type) &&
          (event.kind === undefined || event.kind === spec.kind) &&
          (event.oldPath === undefined || event.oldPath === spec.oldPath) &&
          (event.newPath === (spec.newPath || ''))
      }

      function eventMatching (spec) {
        const isMatch = specMatches.bind(null, spec)
        return function () {
          return events.some(isMatch)
        }
      }

      function allEventsMatching (...specs) {
        return function () {
          let specIndex = 0

          for (const event of events) {
            if (specMatches(specs[specIndex], event)) {
              specIndex++
            }
          }

          return specIndex >= specs.length
        }
      }

      it('when a file is created', async function () {
        const createdFile = path.join(watchDir, 'file.txt')
        await fs.writeFile(createdFile, 'contents')

        await until('the creation event arrives', eventMatching({
          type: 'created',
          kind: 'file',
          oldPath: createdFile
        }))
      })

      it('when a file is modified', async function () {
        const modifiedFile = path.join(watchDir, 'file.txt')
        await fs.writeFile(modifiedFile, 'initial contents\n')

        await until('the creation event arrives', eventMatching({
          type: 'created',
          kind: 'file',
          oldPath: modifiedFile
        }))

        await fs.appendFile(modifiedFile, 'changed contents\n')
        await until('the modification event arrives', eventMatching({
          type: 'modified',
          kind: 'file',
          oldPath: modifiedFile
        }))
      })

      it('when a file is renamed', async function () {
        const oldPath = path.join(watchDir, 'old-file.txt')
        await fs.writeFile(oldPath, 'initial contents\n')

        await until('the creation event arrives', eventMatching({
          type: 'created',
          kind: 'file',
          oldPath,
          newPath: ''
        }))

        const newPath = path.join(watchDir, 'new-file.txt')

        await fs.rename(oldPath, newPath)

        await until('the rename event arrives', eventMatching({
          type: 'renamed',
          kind: 'file',
          oldPath,
          newPath
        }))
      })

      it('when a file is deleted', async function () {
        const deletedPath = path.join(watchDir, 'file.txt')
        await fs.writeFile(deletedPath, 'initial contents\n')

        await until('the creation event arrives', eventMatching({
          type: 'created',
          kind: 'file',
          oldPath: deletedPath
        }))

        await fs.unlink(deletedPath)

        await until('the deletion event arrives', eventMatching({
          type: 'deleted',
          kind: 'file',
          oldPath: deletedPath
        }))
      })

      it('understands coalesced creation and deletion events', async function () {
        const deletedPath = path.join(watchDir, 'deleted.txt')
        const recreatedPath = path.join(watchDir, 'recreated.txt')
        const createdPath = path.join(watchDir, 'created.txt')

        await fs.writeFile(deletedPath, 'initial contents\n')
        await until('file creation event arrives', eventMatching(
          {type: 'created', kind: 'file', oldPath: deletedPath}
        ))

        await fs.unlink(deletedPath)
        await fs.writeFile(recreatedPath, 'initial contents\n')
        await fs.unlink(recreatedPath)
        await fs.writeFile(recreatedPath, 'newly created\n')
        await fs.writeFile(createdPath, 'and another\n')

        await until('all events arrive', allEventsMatching(
          {type: 'deleted', kind: 'file', oldPath: deletedPath},
          {type: 'created', kind: 'file', oldPath: recreatedPath},
          {type: 'deleted', kind: 'file', oldPath: recreatedPath},
          {type: 'created', kind: 'file', oldPath: recreatedPath},
          {type: 'created', kind: 'file', oldPath: createdPath}
        ))
      })

      it('when a directory is created')
      it('when a directory is renamed')
      it('when a directory is deleted')
    })
  })

  describe('unwatching a directory', function () {
    beforeEach(async function () {
      await sfw.configure({mainLogFile, workerLogFile})
    })

    it('unwatches a previously watched directory', async function () {
      let error = null
      const events = []

      const sub = await sfw.watch(watchDir, (err, es) => {
        error = err
        events.push(...es)
      })
      subs.push(sub)

      const filePath = path.join(watchDir, 'file.txt')
      await fs.writeFile(filePath, 'original')

      await until('the event arrives', () => events.some(event => event.oldPath === filePath))
      const eventCount = events.length
      assert.isNull(error)

      await sub.unwatch()

      await fs.writeFile(filePath, 'the modification')

      // Give the modification event a chance to arrive.
      // Not perfect, but adequate.
      await new Promise(resolve => setTimeout(resolve, 100))

      assert.lengthOf(events, eventCount)
    })

    it('is a no-op if the directory is not being watched', async function () {
      let error = null
      const sub = await sfw.watch(watchDir, err => (error = err))
      subs.push(sub)
      assert.isNull(error)

      await sub.unwatch()
      assert.isNull(error)

      await sub.unwatch()
      assert.isNull(error)
    })
  })
})
