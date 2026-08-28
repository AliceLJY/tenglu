import { registerWebModule, NativeModule } from 'expo';

// TengluRegionSamplerModule is not available on the web platform.
class TengluRegionSamplerModule extends NativeModule<{}> {}

export default registerWebModule(TengluRegionSamplerModule, 'TengluRegionSamplerModule');
