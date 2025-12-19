module.exports = {
  plugins: {
    autoprefixer: {
      overrideBrowserslist: [
        '> 1%',
        'last 2 versions',
        'not dead'
      ],
      // Suppress warnings about 'end' value in flexbox
      // This is a known issue in ag-grid-community CSS
      ignoreUnknownVersions: true
    }
  }
};

