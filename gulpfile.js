const gulp = require('gulp');

const babel = require('gulp-babel');
const combine = require('stream-combiner2');
const debug = require('gulp-debug');
const del = require('del');
const rename = require('gulp-rename');
const sourcemaps = require('gulp-sourcemaps');
const watch = require('gulp-watch');

const scriptsPipeline = () => {
  return combine.obj(
    debug(),
    sourcemaps.init(),
    babel(),
    rename((file) => {
      file.dirname = file.dirname.replace(/^src/, '/lib');
      return file.dirname;
    }),
    sourcemaps.write('.')
  ).on('error', (err) => {
    console.log(err.stack);
  });
};

const cleanTaskFactory = (folder) => {
  return () => {
    return del('lib/*', { cwd: folder, base: folder });
  };
};

const buildScriptsTaskFactory = (folder) => {
  return () => {
    return gulp
      .src([
        'src/**/*.js',
        '!src/*/__tests__/**'
      ], { cwd: folder, base: folder })
      .pipe(scriptsPipeline(folder))
      .pipe(gulp.dest(folder));
  };
};

const watchScriptsTaskFactory = (folder) => {
  return (done) => {
    watch([
      'src/**/*.js',
      '!src/*/__tests__/**'
    ], { cwd: folder, base: folder }, (file) => {
      if (file.event === 'unlink') {
        return;
      }
      gulp.src(file.path, { cwd: folder, base: folder })
        .pipe(scriptsPipeline(folder))
        .pipe(gulp.dest(folder));
    }).on('end', done);
  };
};

const copyDockerfiles = (folder) => {
  return () => gulp.src(['src/*/dockerfiles/**/*'], { cwd: folder })
    .pipe(rename((file) => file.dirname))
    .pipe(gulp.dest('lib'));
};

gulp.task('clean', cleanTaskFactory('.'));
gulp.task('build:no-test', buildScriptsTaskFactory('.'));
gulp.task('watch', watchScriptsTaskFactory('.'));
gulp.task('copyDockerfiles', copyDockerfiles('.'));

gulp.task('build', gulp.series('clean', 'build:no-test', 'copyDockerfiles'));
gulp.task('serve', gulp.series('build', 'watch'));
