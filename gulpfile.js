/*
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

'use strict';

const gulp = require('gulp');
const $ = require('gulp-load-plugins')();
const swPrecache = require('sw-precache');
const argv = require('yargs').argv;
const browserSync = require('browser-sync').create();
const del = require('del');
const fs = require('fs');
const hljs = require('highlight.js');
const markdownIt = require('markdown-it')({
    html: true,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(lang, code).value;
        } catch (__) { console.log(__) }
      } else {
        try {
          return hljs.highlightAuto(code).value;
        } catch (__) { console.log(__) }
      }

      return ''; // use external default escaping
    }
  });
const markdownItAttrs = require('markdown-it-attrs');
const merge = require('merge-stream');
const path = require('path');
const toc = require('toc');
const composer = require('gulp-uglify/composer');
const gulpUglifyEs = composer(require('uglify-es'), console);

const AUTOPREFIXER_BROWSERS = ['last 2 versions', 'ios 8', 'Safari 8'];

markdownIt.use(markdownItAttrs);
// keep markdownIt from escaping template markup.
markdownIt.normalizeLink = function(link) { return link; }
markdownIt.validateLink = function(link) { return true; }

// reload is a noop unless '--reload' cmd line arg is specified.
const reload = argv.reload ? browserSync.reload : function() {
  return new require('stream').PassThrough({objectMode: true});
}

gulp.task('generate-service-worker', function() {
  /**
   * NOTE(keanulee): This function is run in the context of the generated SW where variables
   * like `toolbox` and `caches` are defined. It is referenced as a handler by the runtime
   * caching config below which embeds the value of pwShellSWHandler.toString() in the
   * generated SW.
   *
   * This handler will return the cached app shell for all navigate requests and network-first
   * for all other requests.
   */
  function pwShellSWHandler(request, values, options) {
    // Only serve the app shell for navigate requests (not XHRs) of non-sample content.
    if ((request.mode === 'navigate') && !request.url.match('samples')) {
      return caches.open(cacheName).then(function(cache) {
        const url = new URL('/app-shell.html', self.location).toString();
        return cache.match(urlsToCacheKeys.get(url)).then(function(response) {
          if (response) {
            return response;
          }
          throw Error('/app-shell.html missing from cache.');
        });
      }).catch(function(e) {
        // Fall back to fetching the actual content if /app-shell.html is missing.
        // The SW should precache it the next time it initializes.
        console.warn('/app-shell.html missing from cache: %O', e);
        return toolbox.networkFirst(request, values, options);
      });
    } else {
      return toolbox.networkFirst(request, values, options);
    }
  }

  const rootDir = 'dist';
  const partialTemplateFiles = ['head-meta.html', 'site-nav.html']
    .map(file => path.join(rootDir, 'templates', file));

  const config = {
    cacheId: 'polymerproject',
    staticFileGlobs: [
      `${rootDir}/images/logos/p-logo.png`,
      `${rootDir}/images/logos/polymerosaurus.png`,
      `${rootDir}/elements/**`,
      `${rootDir}/js/*.js`,
      `${rootDir}/css/*.css`,
      `${rootDir}/webcomponentsjs/custom-elements-es5-adapter.js`,
      `${rootDir}/webcomponentsjs/webcomponents-loader.js`,
    ],
    dynamicUrlToDependencies: {
      '/': partialTemplateFiles.concat([`${rootDir}/index.html`]),
      '/about': partialTemplateFiles.concat(`${rootDir}/about.html`),
      '/app-shell.html': partialTemplateFiles.concat(`${rootDir}/app-shell.html`),
    },
    runtimeCaching: [
      {
        urlPattern: new RegExp('/images/'),
        handler: 'fastest',
        options: {
          cache: {
            maxEntries: 50,
            name: 'image-cache'
          }
        }
      },
      {
        urlPattern: new RegExp('/webcomponentsjs/.*.js'),
        handler: 'fastest',
        options: {
          cache: {
            name: 'webcomponentsjs-polyfills-cache'
          }
        }
      },
      {
        urlPattern: new RegExp('/(docs|start|toolbox)/'),
        handler: pwShellSWHandler,
        options: {
          cache: {
            maxEntries: 100,
            name: 'docs-cache'
          }
        }
      },
      {
        urlPattern: new RegExp('/samples/'),
        handler: 'fastest',
        options: {
          cache: {
            maxEntries: 20,
            name: 'samples-cache'
          }
        }
      }
    ],
    stripPrefix: rootDir + '/',
    verbose: false  /* When debugging, you can enable this to true  */
  };
  return swPrecache.write(path.join(rootDir, 'service-worker.js'), config);
});

const style = function() {
  const sassOpts = {
    precision: 10,
    outputStyle: 'expanded',
    onError: console.error.bind(console, 'Sass error:')
  };

  return gulp.src('app/sass/**/*.scss')
    .pipe($.changed('dist/css'))
    .pipe($.sass(sassOpts))
    .pipe($.autoprefixer(AUTOPREFIXER_BROWSERS))
    .pipe($.cssmin()) // Minify and add license
    .pipe($.license('BSD2', {
      organization: 'The Polymer Project Authors. All rights reserved.',
      tiny: true
    }))
    .pipe(gulp.dest('dist/css'))
}

style.description = 'Compile sass, autoprefix, and minify CSS';
gulp.task(style);

const images = function() {
  return gulp.src('app/images/**/*')
    .pipe($.changed('dist/images'))
    .pipe($.imagemin({
      progressive: true,
      interlaced: true,
      svgoPlugins: [{convertTransform: false}]
    }))
    .pipe(gulp.dest('dist/images'));
};

images.description = 'Optimize images';
gulp.task(images);

function convertMarkdownToHtml(templateName) {
  return $.grayMatter(function(file) { // pull out front matter data.
    const data = file.data;
    data.file = file;
    data.title = data.title || '';
    data.subtitle = data.subtitle || '';

    let content = file.content;
    // Inline code snippets before running through markdown for syntax highlighting.
    content = content.replace(/<!--\s*include_file\s*([^\s]*)\s*-->/g,
      (match, src) => fs.readFileSync(`app/${src}`));
    // Markdown -> HTML.
    content = markdownIt.render(content);

    // If there is a table of contents, toc-ify it. Otherwise, wrap the
    // original markdown content anyway, so that we can style it.
    if (content.match(/<!--\s*toc\s*-->/gi)) {
      // Leave a trailing opening <div class="article-wrapper"><article> in the TOC, so that we can wrap the original
      // markdown content into a div, for styling
      data.content = toc.process(content, {
        header: '<h<%= level %><%= attrs %> id="<%= anchor %>" class="has-permalink"><%= header %></h<%= level %>>',
        TOC: '<div class="details-wrapper"><details id="toc"><summary>Contents</summary><%= toc %></details></div><div class="article-wrapper"><article>',
        openUL: '<ul data-depth="<%= depth %>">',
        closeUL: '</ul>',
        openLI: '<li data-level="H<%= level %>"><a href="#<%= anchor %>"><%= text %></a>',
        closeLI: '</li>',
        tocMax: 3,
        anchor: function(header, attrs) {
          // if we have an ID attribute, use that, otherwise
          // use the default slug
          var id = attrs.match(/(?:^|\s+)id="([^"]*)"/)
          return id ? id[1] : toc.anchor(header);
        }
      }) + '</article></div>';
    } else {
      data.content = '<div class="article-wrapper"><article>' + content + '</article></div>';
    }

    const tmpl = fs.readFileSync(templateName);
    const renderTemplate = $.util.template(tmpl);

    return renderTemplate(data);
  });
}

const mdDocs = function() {
  return gulp.src([
      'app/**/*.md',
      '!app/{elements,images,js,sass}/**',
    ], {base: 'app/'})
    .pipe(convertMarkdownToHtml('templates/page.template'))
    .pipe($.rename({extname: '.html'}))
    .pipe(gulp.dest('dist'));
};

mdDocs.description = 'Docs markdown -> HTML conversion. Syntax highlight and TOC generation';
gulp.task('md:docs', mdDocs);

const jshint = function() {
  return gulp.src([
      'gruntfile.js',
      'app/js/**/*.js',
      'app/elements/**/*.js',
      'app/elements/**/*.html'
    ])
    .pipe($.changed('dist/js'))
    .pipe($.jshint.extract()) // Extract JS from .html files
    .pipe($.jshint({esnext: true}))
    .pipe($.jshint.reporter('jshint-stylish'))
    .pipe($.if(!browserSync.active, $.jshint.reporter('fail')));
};
jshint.description = 'Lint JS';
gulp.task('jshint', jshint);

const js = function() {
  const externalJs = require('polymer-cli/node_modules/polymer-build/lib/external-js');
  const helperCodeSnippets = [
    externalJs.getBabelHelpersFull(),
    '\n',
    externalJs.getAmdLoader(),
    '\n',
    fs.readFileSync(require.resolve('web-animations-js/web-animations-next-lite.min.js'), 'utf-8'),
    '\n'
  ];
  return gulp.src(['app/js/**/*.js'])
    .pipe($.header(helperCodeSnippets.join('')))
    .pipe(gulpUglifyEs()) // Minify js output
    .pipe(gulp.dest('dist/js'));
}

js.description = 'Minify JS to dist/';
gulp.task('js', js);

const buildBundles = function() {
  return merge(
    $.run('polymer build').exec());
}

buildBundles.description =  'Build element bundles';
gulp.task('build-bundles', buildBundles);

const copy = function() {
  const app = gulp.src([
      '*',
      'app/manifest.json',
      '!{README.md,package.json,gulpfile.js}',
    ], {nodir: true})
    .pipe(gulp.dest('dist'));

  // HTML pages (such as index.html) use gulp-highlight instead of the markdown
  // code highlighter. It's slower than the markdown one since it has to parse
  // the page to look for code snippets, so it's only used for non-markdown pages.
  const docs = gulp.src([
      'app/**/*.html',
      '!app/elements/**',
     ], {base: 'app/'})
    .pipe($.highlight({
      selector: 'pre code'
    }))
    .pipe(gulp.dest('dist'));

  const samples = gulp.src([
      'app/3.0/docs/samples/**/*',
      'app/3.0/samples/**/*',
    ], {base: 'app/'})
    .pipe(gulp.dest('dist'));

  const gae = gulp.src([
      'app/**/nav.yaml',
      '{templates,lib}/**/*'
     ])
    .pipe(gulp.dest('dist'));

  const webcomponentsjs = gulp.src([
      'node_modules/@webcomponents/webcomponentsjs/**'
    ], {base: 'node_modules/@webcomponents/'})
    .pipe(gulp.dest('dist'));

  // Copy the bundles that polymer build produced.
  const bundles = gulp.src([
      'build/default/app/elements/*'
    ])
    .pipe(gulp.dest('dist/elements'));

  return merge(app, docs, samples, gae, webcomponentsjs, bundles);
}

copy.description = 'Copy site files (polyfills, templates, etc.) to dist/';
gulp.task('copy', copy);

const watch = function() {
  browserSync.init({
    notify: true,
    open: !!argv.open,
    proxy: 'localhost:8080' // proxy serving through app engine.
  });
  gulp.watch('app/sass/**/*.scss', gulp.series('style', reload));
  gulp.watch('app/elements/**/*', function() {
    gulp.series('build-bundles', 'copy');
    reload();
  });
  gulp.watch('app/js/*.js', gulp.series('js', reload));

  gulp.watch('app/**/*.md', gulp.series('md:docs', reload));
  gulp.watch(['templates/*.html', 'app/**/*.html'], gulp.series('copy', reload));
  // Watch for changes to server itself.
  gulp.watch('*.py', function(files) {
    gulp.src('*.py').pipe(gulp.dest('dist'));
    reload();
  });
  gulp.watch('app/**/*.{yaml,yml}', function(files) {
    gulp.src('app/**/*.{yml,yaml}').pipe(gulp.dest('dist'));
    reload();
  });
}

watch.description = 'Watch files for changes';
gulp.task('watch', watch, {
  options: {
    'reload': 'Reloads browser tab when watched files change',
    'open': 'Opens a browser tab when launched'
  }
});

const clean = function() {
  return del(['dist', 'app/css']);
}

clean.description = 'Remove dist/ and other built files';
gulp.task('clean', clean);

// Default task. Build the dest dir.
const defaultTask =  gulp.series(
    'build-bundles',
    gulp.parallel('copy', 'md:docs', 'style', 'images', 'js'),
    'generate-service-worker',
  );

defaultTask.description = 'Build site';
gulp.task('default', defaultTask);
