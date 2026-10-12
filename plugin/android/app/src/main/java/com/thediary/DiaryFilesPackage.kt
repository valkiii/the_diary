package com.thediary

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * Registers DiaryFilesModule. PluginHost loads native modules from the
 * "reactPackages" list that buildPlugin.sh writes into PluginConfig.json by
 * scanning for ReactPackage classes, so this class is all that is needed.
 */
class DiaryFilesPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(DiaryFilesModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<out View, out ReactShadowNode<*>>> = emptyList()
}
