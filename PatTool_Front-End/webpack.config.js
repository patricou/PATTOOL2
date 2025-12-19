module.exports = (config, options) => {
  // Suppress warnings about 'end' value in ag-grid-community CSS
  // This warning is harmless and comes from a third-party library
  config.ignoreWarnings = config.ignoreWarnings || [];
  config.ignoreWarnings.push({
    module: /node_modules\/ag-grid-community/,
    message: /end value has mixed support/
  });
  
  // Also suppress warnings from postcss-loader about this issue
  config.ignoreWarnings.push({
    message: /end value has mixed support, consider using flex-end instead/
  });

  return config;
};

