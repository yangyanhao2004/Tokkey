const PackagingConfiguration = require('./scripts/PackagingConfiguration.cjs');

// The update feed is embedded at build time; credentials stay in the environment.
module.exports = new PackagingConfiguration().create();
