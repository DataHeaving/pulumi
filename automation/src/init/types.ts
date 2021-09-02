export type PulumiPluginPackageInformation =
  PulumiPluginPackageInformationMandatory &
    Partial<PulumiPluginPackageInformationOptional>;

export type PulumiPluginPackageInformationFull =
  PulumiPluginPackageInformationMandatory &
    PulumiPluginPackageInformationOptional;

export interface PulumiPluginPackageInformationMandatory {
  pluginName: string;
}

export interface PulumiPluginPackageInformationOptional {
  packageName: string;
  utilsSuffix: string;
  getVersionFunctionName: string;
  processVersion: (version: string) => string;
}
