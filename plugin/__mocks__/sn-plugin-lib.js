// Jest stand-in for the device SDK (its sources are untranspiled ESM and need the host).
module.exports = {
  PluginManager: {getPluginDirPath: async () => null},
  Element: {TYPE_STROKE: 0, TYPE_GEO: 700},
};
