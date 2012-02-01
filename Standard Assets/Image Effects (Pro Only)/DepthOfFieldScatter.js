
#pragma strict

@script ExecuteInEditMode
@script RequireComponent (Camera)
@script AddComponentMenu ("Image Effects/Depth of Field (HDR, Scatter)") 

class DepthOfFieldScatter extends PostEffectsBase {	
    public var foregroundBlur : boolean = false;
    public var visualizeFocus : boolean = false;
	
	public var focalPoint : float = 1.0f;
	public var smoothness : float = 2.5f;
	public var foregroundCurve : float = 1.0f;
	public var backgroundCurve : float = 1.0f;

	public var focalTransform : Transform = null;
	public var focalSize : float = 0.0f; 

	public var apertureSize : float = 2.25f; 
	
	public enum BlurType {
		Poisson = 0,
		Production = 1,
		Movie = 2,
	}
	
	public enum BlurResolution {
		High = 0,
		Low = 1,
	}
	 
	public var blurType : BlurType = BlurType.Production;
	public var blurResolution : BlurResolution = BlurResolution.Low;
	
	public var foregroundOverlap : float = 0.85f;
	public var dofHdrShader : Shader;		
	
	private var focalStartCurve : float = 2.0f;
	private var focalEndCurve : float = 2.0f;
	private var focalDistance01 : float = 0.1f;	
	private var dofHdrMaterial : Material = null;		        
        	
	function CheckResources () : boolean {		
		CheckSupport (true);
	
		dofHdrMaterial = CheckShaderAndCreateMaterial (dofHdrShader, dofHdrMaterial); 
		
		if(!isSupported)
			ReportAutoDisable ();
		return isSupported;		  
	}

	function OnEnable() {
		camera.depthTextureMode |= DepthTextureMode.Depth;		
	}
	
	function FocalDistance01 (worldDist : float) : float {
		return camera.WorldToViewportPoint((worldDist-camera.nearClipPlane) * camera.transform.forward + camera.transform.position).z / (camera.farClipPlane-camera.nearClipPlane);	
	}
			
	function OnRenderImage (source : RenderTexture, destination : RenderTexture) 
	{		
		if(CheckResources()==false) {
			Graphics.Blit (source, destination);
			return;
		}
		
		var i : int = 0;
		var internalBlurWidth : float = apertureSize;
		var blurRtDivider : int = blurResolution == BlurResolution.High ? 1 : 2;
		
		// clamp values so they make sense

		if (smoothness < 0.4f) smoothness = 0.4f;
		if (focalSize < 0.00001f) focalSize = 0.00001f;
		if (foregroundCurve < 0.01f) foregroundCurve = 0.0f;
		if (backgroundCurve < 0.01f) backgroundCurve = 0.0f;
					
		// calculate needed focal parameters

		var focal01Size : float = focalSize / (camera.farClipPlane - camera.nearClipPlane);
		focalDistance01 = focalTransform ? (camera.WorldToViewportPoint (focalTransform.position)).z / (camera.farClipPlane) : FocalDistance01 (focalPoint);
		focalStartCurve = focalDistance01 * smoothness;
		focalEndCurve = focalStartCurve;
		
		var isInHdr : boolean = source.format == RenderTextureFormat.ARGBHalf;
		
		var scene : RenderTexture = blurRtDivider > 1 ? RenderTexture.GetTemporary(source.width/blurRtDivider, source.height/blurRtDivider, 0, source.format) : null;			
		
		var rtLow : RenderTexture = RenderTexture.GetTemporary(source.width/(2*blurRtDivider), source.height/(2*blurRtDivider), 0, source.format);		
		var rtLow2 : RenderTexture = RenderTexture.GetTemporary(source.width/(2*blurRtDivider), source.height/(2*blurRtDivider), 0, source.format);			
		rtLow.filterMode = FilterMode.Bilinear;
		rtLow2.filterMode = FilterMode.Bilinear;
	
		dofHdrMaterial.SetVector ("_CurveParams", Vector4 (foregroundCurve / focalStartCurve, backgroundCurve / focalEndCurve, focal01Size * 0.5, focalDistance01));
		dofHdrMaterial.SetVector ("_InvRenderTargetSize", Vector4 (1.0 / (1.0 * source.width), 1.0 / (1.0 * source.height),0.0,0.0));
		
		if (foregroundBlur) {
			// TODO: optimize this one away
			var rtTmp : RenderTexture = RenderTexture.GetTemporary(source.width/(2*blurRtDivider), source.height/(2*blurRtDivider), 0, source.format);
			
			// Capture foreground CoC only in alpha channel and increase CoC radius
			Graphics.Blit (source, rtTmp, dofHdrMaterial, 4); 
			dofHdrMaterial.SetTexture("_FgOverlap", rtTmp); 
			
			var fgAdjustment : float = internalBlurWidth * foregroundOverlap * 0.225f;
			dofHdrMaterial.SetVector ("_Offsets", Vector4 (0.0f, fgAdjustment , 0.0f, fgAdjustment));
			Graphics.Blit (rtTmp, rtLow2, dofHdrMaterial, 2);
			dofHdrMaterial.SetVector ("_Offsets", Vector4 (fgAdjustment, 0.0f, 0.0f, fgAdjustment));		
			Graphics.Blit (rtLow2, rtTmp, dofHdrMaterial, 2);	 			
			
			// apply adjust FG coc back to high rez coc texture
			Graphics.Blit(rtTmp, source, dofHdrMaterial, 7);
						
			RenderTexture.ReleaseTemporary(rtTmp);
		}
		else 
			dofHdrMaterial.SetTexture("_FgOverlap", null); // ugly FG overlaps as a result
		
		// capture remaing CoC (fore & *background*)
		
		Graphics.Blit (source, source, dofHdrMaterial, foregroundBlur ? 3 : 0);		
		
		var cocRt : RenderTexture = source;
		
		if(blurRtDivider>1) {
			Graphics.Blit (source, scene, dofHdrMaterial, 6);		
			cocRt = scene;	
		}
		
		// spawn a few low rez parts in high rez image => nicer, bigger blur for free
		
		Graphics.Blit(cocRt, rtLow2, dofHdrMaterial, 6); 
		Graphics.Blit(rtLow2, cocRt, dofHdrMaterial, 8);

		//  blur
		
		var blurPassNumber : int = 10;
		switch(blurType) {
			case BlurType.Poisson:
				blurPassNumber = blurRtDivider > 1 ? 10 : 13;
				break;
			case BlurType.Production:
				blurPassNumber = blurRtDivider > 1 ? 12 : 11;
				break;
			case BlurType.Movie:
				blurPassNumber = blurRtDivider > 1 ? 15 : 14;
				break;				
			default:
				Debug.Log("DOF couldn't find valid blur type", transform);
				break;
		}
		
		if(visualizeFocus) {
			Graphics.Blit (source, destination, dofHdrMaterial, 1);
		}
		else { 		 
			dofHdrMaterial.SetVector ("_Offsets", Vector4 (0.0f, 0.0f , 0.0f, internalBlurWidth));
			dofHdrMaterial.SetTexture("_LowRez", cocRt); // only needed in low resolution profile. and then, ofc, we get an ugly transition from nonblur->blur areas
			Graphics.Blit (source, destination, dofHdrMaterial, blurPassNumber);	 
		}
		
		if(rtLow) RenderTexture.ReleaseTemporary(rtLow);
		if(rtLow2) RenderTexture.ReleaseTemporary(rtLow2);		
		if(scene) RenderTexture.ReleaseTemporary(scene); 
	}	
}
